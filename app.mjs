"use-strict";
import HeosApi from "heos-api"
import RoonApi from "node-roon-api"
import RoonApiSettings from "node-roon-api-settings"
import RoonApiStatus from "node-roon-api-status"
import RoonApiVolumeControl from "node-roon-api-volume-control" 
import RoonApiSourceControl from "node-roon-api-source-control"
import RoonApiTransport from "node-roon-api-transport"
import child from "node:child_process"
import util, { isArray } from "node:util"
import fs from "node:fs/promises"
import os from "node:os"
import xml2js, { parseStringPromise } from "xml2js"
import ip from "ip"
let roon,svc_status,my_settings,svc_source_control,svc_transport,svc_volume_control,rheos_connection = {}
let rheos_processes = {}
let mode = false
let timer
let discovery =  0
let working = false
const start_time = new Date ()
const queue_array = []
const execFileSync = util.promisify(child.execFile);
const spawn = (child.spawn)
const rheos_players = new Map ()
const rheos_zones = new Map ()
const rheos_groups = new Map ()
const builder = new xml2js.Builder({async : true})
const system_info =[ip.address(),os.type(),os.hostname(),os.platform(),os.arch()]
await start_roon()
await start_up()
await set_permissions()
await discover_devices().catch(err=> console.error(err))
await build_devices().catch(err=> console.error(err))
await create_players().catch(err=> console.error(err))
await add_listeners().catch(err=> console.error(err))

await start_listening().catch(err=> console.error(err))
await get_heos_groups()


console.log(system_info.toString())
console.table([...rheos_players.values()],["name","pid","model","ip","status"])
async function monitor(){
	setInterval(async ()=>{
		heos_command("system","heart_beat",{}).catch(err=> console.error("HEARTBEAT MISSED",err))
		svc_transport.get_outputs((err,ops)=>{
			if (!ops){return}
			for (const op of ops?.outputs){
				let player = get_player(op.display_name)  
					if (player) {
						player.output = op
						player.zone = op.zone_id
					}	
			}
			update_status()
		})
	},5000)
	return
}
async function add_listeners() {	
	const listeners = await rheos_connection[0]
    listeners.write("system", "register_for_change_events", { enable: "on" })
	listeners
		.on({ commandGroup: "system", command: "heart_beat" }, async (res) => {
			res?.heos?.result == "success" || console.error("HEARTBEAT failed",res)	
		})
		.onClose(async (hadError) => {
			console.error("Listeners closed", hadError)
			await start_up().catch(err=> {console.log(err)})
			await set_permissions().catch(err=> {console.log(err)})
			await discover_devices().catch(err=> {console.log(err)})
			await build_devices().catch(err=> console.error(err))
			await create_players().catch(err=> console.error(err))
			await add_listeners().catch(err=> console.error(err))
			await start_listening().catch(err=> console.error(err))
		})
		.onError((err) => console.error("ERROR",err))
		.on({ commandGroup: "event", command: "groups_changed" }, async (res) => {	
			res =	await heos_command("group","get_groups").catch(err=> console.error(err))
			if (! res.payload && res.result == 'success') {
				

				console.log("I JUST CLEARED ALL GROUPS", console.log([...rheos_zones.values]))
				rheos_groups.clear()
			
			}
            if (res.payload.length < rheos_groups.size){
				//console.log("SEEING IF DELETED A ZONE",res.payload.length,rheos_groups.size,[...rheos_zones.values()].filter(zone => zone.outputs.length>1).length,rheos_zones)
               let cleared_zones = ([...rheos_zones.values()].filter(zone => (zone.outputs.length >1) && (!res.payload.map(group => group.gid).includes(get_pid(zone.outputs[0].display_name)))))
			   for (const zone of cleared_zones){
				console.log("CLEARING ZONE",zone.display_name)
				rheos_groups.delete(get_pid(zone.outputs[0].display_name))
			    svc_transport.ungroup_outputs(zone.outputs.map(output => output?.output_id))
			   }
			}
			for (let group of res.payload){
				let players = group.players.sort(
					(a,b) => {
							let fa = a.role=="leader" ? 0 : 1
							let fb = b.network == "leader" ? 0 : 1
							return fa - fb}
				)
				const zone = rheos_zones.get(rheos_players.get(group.gid).zone)
				
				if (sum_array(zone?.outputs.map(o => get_pid(o.display_name))) !== sum_array(players.map(player => player.pid))){
					if (zone?.outputs.length > players.length){
						const ungroup = zone?.outputs.filter(o => { return !players.map(player => player.name).includes(o.display_name)})
						svc_transport.ungroup_outputs(ungroup)
					} else if (zone?.outputs?.length < players.length){
						let group = players.map(player => rheos_players.get(player.pid)?.output)
						 svc_transport.group_outputs(group)
					}
				}
			}
		})	
		.on({ commandGroup: "event", command: "players_changed" }, async (res) => {
			const players = await heos_command("player", "get_players").catch(err=> console.error("PLAYERS",err))
			const player_names = players.payload.map(player => player.name)
			const new_players = players.payload.filter(player => !player.output)
			const deleted_players = [...rheos_players.values()].filter(player=> !player_names.includes(player.name))
			for (let player of new_players)	{
				//await create_players()
				my_settings[player.name]="Off"
			}
			for (let player of deleted_players){
				rheos_players.delete(player.pid)
				delete my_settings[player.name]
			}
		})
		.on({ commandGroup: "event", command: "player_playback_error" }, async (res) => {
			console.error(res)
		})
		.on({ commandGroup: "event", command: "player_volume_changed"}, async (res) => {
			const {heos:{message:{parsed: { mute,level, pid }}}} = res, player = rheos_players.get(pid)	
			if (player?.volume?.mute && (mute != player.volume.mute)) {
				player.volume.mute = mute
				
				svc_transport.mute(player.output, (mute == 'on'? 'mute' : 'unmute'))
			} 
			else if ( player?.volume?.level && (level !== player?.volume?.level)){
				player.volume.level = level
				svc_transport.change_volume(player.output, 'absolute',level)
			}  
		})
}
async function discover_devices() {
	console.log("DISCOVERING HEOS DEVICES")
	return new Promise(async function(resolve,reject){
		const players = ([...rheos_players.values()].map(player => player.name))
		
		try {
			const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8').catch(new Error  ("file needs to be created"))	
			const slim_devices = await parseStringPromise(data)
			if (data && slim_devices.squeeze2upnp.device.map(d => d.friendly_name[0]).toString().length == players.toString().length){
				resolve (data)
			} else {
				throw "players have changed"
			}	
		}
		catch {
			let message = setInterval(function(){discovery ++; 
				update_status()
			},1000)
			await  create_root_xml().catch(console.log("CREATING NEW XML ROOT"))
			const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8').catch(new Error  ("file needs to be created"))
			discovery = 0
			clearInterval(message)
			data && resolve(data) || reject()
		}
	})
}
async function create_root_xml(){
	return new Promise(function (resolve){
		execFileSync(choose_binary(), ['-i', './UPnP/Profiles/config.xml','-b', ip.address()],()=> {resolve()});
	}) 
}
async function start_up(){	
	const heos = [HeosApi.discoverAndConnect({timeout:1000,port:1255, address:ip.address()}),HeosApi.discoverAndConnect({timeout:1000,port:1256, address:ip.address()})]
        try {
            rheos_connection = await Promise.all(heos)
			rheos_connection[0].socket.setMaxListeners(0)
				let players = await get_players(rheos_connection[0])	
				for (let player of players)	{
					player.status = my_settings[player.name]
					rheos_players.set (player.pid, player)	
				}
				players
				.sort((a,b) => {
					let fa = a.network =="wired" ? 0 : 1
					let fb = b.network == "wired" ? 0 : 1
					return fa - fb
				})			
        }
        catch (err) {
			throw "Unable to connect discover any Heos Players"
		}	  
    return([...rheos_players.values()] || [])
}
async function get_players(){ 
        return new Promise(function (resolve,reject){
            rheos_connection[0].write("player","get_players",{})
            .once({commandGroup:'player', command : 'get_players'},(players)=>{
                if (players?.payload?.length){ 
                    resolve (players?.payload)
                } else if (players.heos.result == "fail") {
                    reject (players)
                } else if(players.heos.message.unparsed == "command under process"){
                    rheos_connection[0].once({commandGroup:'player', command : 'get_players'},
                    (res) => {
                        resolve (res.payload)
                    })
                } else {
                	reject (players)
                }
            })
        })
}
async function create_players(){
	
	if (mode){	
		if (rheos_processes.main && !rheos_processes.main.killed){
			
			let x = rheos_processes.main.kill(2)}
	} else {
		if (!rheos_processes.main || rheos_processes.main.killed){
			(fs.truncate('./UPnP/common.log',0).catch(()=>{}))
		}
			console.log("RE CREATING ALL")
			rheos_processes.main = spawn(choose_binary(), ['-b',ip.address(),'-Z','-M','RHEOS','-f','./UPnP/common.log','-x','./UPnP/Profiles/config.xml'],{stdio:'ignore'});
		
	} 
	for (let player of rheos_players.values()){
		if (mode){
			if (!rheos_processes[player.pid] || rheos_processes[player.pid].killed){
				
				await (fs.truncate('./UPnP/Profiles/'+player.name.replace(/\s/g,"")+'.log',0).catch(()=>{}))
				rheos_processes[player.pid] = spawn(choose_binary(), ['-b',ip.address(),'-Z','-M','RHEOS: select Enable and then '+'\r\n'+ 'Edit "' +player.name+ '" and Save Extension Settings ',
				'-x','./UPnP/Profiles/'+player.name.replace(/\s/g,"")+'.xml','-f','./UPnP/Profiles/'+player.name.replace(/\s/g,"")+'.log'],{stdio:'ignore'})
			}
		}else{
			if (rheos_processes[player.pid] && !rheos_processes[player.pid].killed){rheos_processes[player.pid].kill(2)}
		
		}
	}
	
}
async function start_roon() {
    roon =  connect_roon()
    svc_status = new RoonApiStatus(roon),
    svc_source_control = new RoonApiSourceControl(roon),
    svc_volume_control = new RoonApiVolumeControl(roon),
    svc_transport = new RoonApiTransport(roon),
    my_settings = roon.load_config("settings") || {}
	my_settings.host_ip ||(my_settings.host_ip = ip.address())
    my_settings.streambuf_size || (my_settings.streambuf_size = 524288)
	my_settings.output_size || (my_settings.output_size = 8388608)
	my_settings.stream_length || (my_settings.stream_length = -3)
	my_settings.seek_after_pause || (my_settings.seek_after_pause = 1)
	my_settings.volume_on_play || (my_settings.volume_on_play = -1)
	my_settings.volume_feedback || (my_settings.volume_feedback = 0)
	my_settings.accept_nexturi|| (my_settings.accept_nexturi = 0)
	my_settings.flac_header || (my_settings.flac_header = 2)
	my_settings.keep_alive || (my_settings.keep_alive = 0)
	my_settings.next_delay || (my_settings.next_delay = 15)
	my_settings.flow || (my_settings.flow  = false)
	my_settings.send_coverart || (my_settings.send_coverart = 0)
	my_settings.send_metadata || (my_settings.send_metadata = 0)
    const svc_settings = new RoonApiSettings(roon, {
        get_settings: async function (cb) {
			mode = true
			await update_status()
			await create_players()
            cb(makelayout(my_settings))
        },
        save_settings: async function (req, isdryrun, settings) {
			mode = false
			create_players()
			
            let l = makelayout(settings.values)
			if (l.values.default_player_ip && !l.has_error){
            	await HeosApi.connect(l.values.default_player_ip,1000).catch(err => (l.has_error = err))
			}	
            req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l })
            if (!isdryrun && !l.has_error) {
				mode = false
				update_status()
                my_settings = l.values
                svc_settings.update_settings(l)
                roon.save_config("settings", my_settings)
				await build_devices()	
            }
        }
    })
    roon.init_services({
        required_services: [RoonApiTransport],provided_services: [svc_status, svc_source_control, svc_volume_control, svc_settings]
    })
    roon.logging = "EVENT"
    roon.start_discovery()
    return roon
}
function connect_roon(){
    const roon = new RoonApi({
		extension_id: "com.Linvale115.test",
		display_name: "RHeos",
		display_version: "0.3.1-8",
		publisher: "RHEOS",
		email: "Linvale115@gmail.com",
		website: "https://github.com/LINVALE/RHEOS",
		log_level: "none",
		core_paired: async function (core) {
			clearInterval(timer)
			await monitor()
			svc_transport = core.services.RoonApiTransport
			svc_transport.subscribe_outputs(async function (cmd, data) {     
				if (cmd == "Subscribed") {
					data.outputs?.forEach((op) => {
						const player = [...rheos_players.values()].find(x => x.name == op.display_name)
						if (player) {
							player.output = op
							player.zone = op.zone_id
						}	
					})	
				}
				if (cmd == "Changed"&& data.outputs_changed) {		
					for await (let op of data.outputs_changed){ 	
						let player = get_player(op.display_name)
						if (player?.name && op?.volume){
							if ((player.volume?.mute !== (op?.volume?.is_muted ? "on" : "off")) && op?.volume?.is_muted !== player?.output?.volume?.is_muted){	
									player.volume = {level:op?.volume?.value, mute : op?.volume?.is_muted ? "on" : "off"}
									await heos_command("player", "set_mute", {pid : player.pid , state :op?.volume?.is_muted ? "on" : "off"}).catch(err=> console.error(err))	
							}
							if (player.volume?.level !== op.volume.value && op.volume.value !== player?.output?.volume?.value){
								player.volume = {level:op.volume.value, mute : op?.volume?.is_muted ? "on" : "off"}	
								await heos_command("player", "set_volume", {pid : player.pid , level :op.volume.value}).catch(err=> console.error(err))	
							}	
						} 
						if (player){
							player.output = op
							player.zone = op.zone_id	
						}
					}
				}  
				if (cmd == "Changed"&& data.outputs_added) {
					data.outputs_added?.forEach((op) => {
						const player = [...rheos_players.values()].find(x => x.name == op.display_name)
						if (player){
							player.output = op
							player.zone = op.zone_id
							player.volume = {level:op?.volume?.value, mute : op?.volume?.is_muted ? "on" : "off"}
						}
					})
				}
				if (cmd == "Changed"&& data.outputs_removed) {
					data.outputs_removed?.forEach((op) => {
						const player = get_player(op.display_name)
						if (player){
								player.output = undefined
								player.zone = undefined
						}
					})
				}
				if (cmd == "Network Error") {
					console.error("NETWORK ERROR", cmd)
					start_roon()
				} 
			})
			svc_transport.subscribe_zones(async function (cmd, data) {
				if (cmd == "Subscribed") {
					if (data.zones) {
						for (const e of data.zones){
							rheos_zones.set(e.zone_id,e)
							//const zone = rheos_zones.get(e.zone_id)
							console.log("SUBSCRIBED",e.display_name)
							//const group = e.outputs.map(o => {return {output_id:o?.output_id,name: o?.display_name,pid: get_pid(o?.display_name)}})
							//if (group.length >1) {
							//	zone.group = group
							//	group_enqueue(group.map(player => player.pid))	.catch(err=> console.error( err))
							
							//} else {zone.group = []}
						}
					}				
					return roon
				}
				if (cmd === "Changed") {
					if (data.zones_changed || data.zones_added || data.zones_removed) { console.log("_".repeat(100))}
					//console.log(data)
					if (data.zones_seek_changed){
						for (const z of data.zones_seek_changed ){
							
							let zone = rheos_zones.get(z.zone_id)
							//console.log("ZONE SEEK CHANGED", zone.display_name)
							if(zone?.state === 'playing'   && z.seek_position % 5 == 0){	
								
								//for (const output of zone.outputs){
									if (z.seek_position === null ){	
										await create_players()
										console.error(new Date().toString().replace("GMT-0400 (Eastern Daylight Time)",""),zone.display_name," ▶ ")
									} 
								//}
							}
						}
					}
					if (data.zones_removed){
						for  (const e of data.zones_removed){
						    console.log("REMOVED ZONE",rheos_zones.get(e).display_name)
							const zone = rheos_zones.get(e)
							await get_heos_groups()
							//console.log("RHEOS GROUPS",rheos_groups)
							const group = rheos_groups.get(get_pid(zone?.outputs[0].display_name))
							rheos_zones.delete(e)
								//console.log("ZONE REMOVED ",zone.display_name)
							
							console.log("REMOVED GROUP ",rheos_groups.get(get_pid(zone?.outputs[0].display_name)))
							if (group){
								console.log("EXISTING GROUP FOUND ",zone?.outputs[0].display_name)
								group_enqueue([get_pid(zone?.outputs[0].display_name)]).catch(err=> console.error("ERROR ENQUEING 1",err))	
								rheos_groups.delete(get_pid(zone?.outputs[0].display_name))
								
							
							}
							
						}
					}					
					if (data.zones_added){
						for  await (const e of data.zones_added){
								//if (e.outputs.length >1) {
									console.log("ZONE ADDED",e.display_name)
									console.log(e.outputs[0].display_name,get_pid(e.outputs[0].display_name),rheos_groups )
									//let group = (rheos_groups.get(get_pid(e.outputs[0].display_name)))
									let group = (rheos_groups.get(get_pid(e.outputs[0].display_name)))
									console.log("GROUP",group)
await get_heos_groups()

									let roon_group = (e.outputs.map(output => get_pid(output.display_name)))
									let heos_group = group?.players ? group?.players.map(player => player.pid) : group
									if(roon_group.length > 1 && (sum_array(roon_group) !==sum_array(heos_group))){
										console.log("NEW GROUP NEEDED",JSON.stringify (roon_group),JSON.stringify(heos_group))
									//console.log("NEW GROUP NEEDED")
									//let heos_group = group?.players ? group?.players.map(player => player.pid) : group
									//let roon_group = (e.outputs.map(output => get_pid(output.display_name)))
									//console.log("ROON GROUP",roon_group,"HEOS GROUP",heos_group)
									//if ((sum_array(roon_group) !== sum_array(heos_group))){
										//rheos_groups.set(roon_group[0],roon_group)
									group_enqueue(roon_group)	.catch(err=> console.error("ERROR ENQUEING 2", err))
									//}
								}
								
								//if (e.outputs.length == 1){
								//	if(rheos_groups.get(get_pid(e.outputs[0].display_name))){
								//		console.log("ZONE CHANGED LENGTH = 1")
								//		let roon_group = (e.outputs.map(output => get_pid(output.display_name)))
								//		rheos_groups.delete(roon_group[0])
								//	    group_enqueue([get_pid(e.outputs[0].display_name)])	.catch(err=> console.error(err))
								//	}
								//}								
							rheos_zones.set(e.zone_id,e)
						
							}
					}
					
					if (data.zones_changed ){	
						for  (const e of data.zones_changed){
								//console.log("ZONE OUTPUTS CHANGED",e.display_name)
							//console.log("ZONE CHANGED",e.display_name,JSON.stringify(e.outputs.map(output => output.output_id)))
							console.log("ZONE OUTPUTS CHANGED",e.display_name)
							await get_heos_groups()
							console.log(e.outputs[0].display_name,get_pid(e.outputs[0].display_name),rheos_groups )
							let group = (rheos_groups.get(get_pid(e.outputs[0].display_name)))
							console.log("GROUP",group)
							let roon_group = (e.outputs.map(output => get_pid(output.display_name)))
							let heos_group = group?.players ? group?.players.map(player => player.pid) : group
							if(roon_group.length > 1 && (sum_array(roon_group) !==sum_array(heos_group))){
						    console.log("NEW GROUP NEEDED",JSON.stringify (roon_group),JSON.stringify(heos_group))
							//	if (e.outputs.length >1) {
							//		let group = (rheos_groups.get(get_pid(e.outputs[0].display_name)))
							//			let heos_group = group?.players ? group?.players.map(player => player.pid) : group
							//			let roon_group = (e.outputs.map(output => get_pid(output.display_name)))
							//			if (sum_array(roon_group) !== sum_array(heos_group)){
											//rheos_groups.set(roon_group[0],roon_group)
											group_enqueue(roon_group).catch((err) => console.error("ERROR ENQUEING 3",err))
							//			}
							//	}
							}
							rheos_zones.set(e.zone_id,e) 
						}
					}
					
				} 
			})
		},
		core_unpaired: function (core) {
			core = undefined
		}
    })
    timer = setInterval(() => console.warn(" ⚠ Please ensure RHEOS is enabled in Settings -> Extensions"), 10000)	
    return  (roon)
}
async function heos_command(commandGroup, command, attributes = {}, timer = 5000) {
	typeof attributes === "object" || ((timer = attributes), (attributes = {}))
	return new Promise(function (resolve, reject) {
		let t = setTimeout(()=>{return reject("TIMEOUT")},timer)
		rheos_connection[0].write(commandGroup, command, attributes)
		rheos_connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
			res.parsed = res.heos.message.parsed
			res.result = res.heos.result
			if (res.heos.result === "success") {
				if (res.heos.message.unparsed.includes("under process")){		
					rheos_connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
						if (res.heos.result === "success") {
							clearTimeout(t)		
							console.log(res.heos.message.parsed.pid == attributes.pid.toString() )
							resolve(res)	
						} else {
							clearTimeout(t)	
							reject(res)
						}
					})
				} else {
					clearTimeout(t)	
					resolve(res)
				} 	
			} else {
				if (res.heos.message.unparsed.includes("not executed")){
					clearTimeout(t)	
					resolve(res)
				} 
			clearTimeout(t)	
			resolve(res)
			}
		})
	})
}
async function build_devices(){
	console.log("building")
	return new Promise(async function(resolve){
	let template,xml_template={}
	template ={
		"squeeze2upnp": {
			"common": [
				{	"enabled": ['0'],
					"streambuf_size": [my_settings.streambuf_size],
					"output_size": [my_settings.output_size],
					"stream_length": [my_settings.stream_length],
					"codecs": ["aac,ogg,flc,alc,pcm,mp3"],
					"forced_mimetypes": ["audio/mpeg,audio/vnd.dlna.adts,audio/mp4,audio/x-ms-wma,application/ogg,audio/x-flac"	],
					"mode": [("flc:0,r:-48000,s:16").toString().concat(my_settings.flow ?",flow":"")],
					"raw_audio_format": ["raw,wav,aif"],
					"sample_rate": ['48000'],
					"L24_format": ['2'],
					"roon_mode": ['1'],
					"seek_after_pause": [my_settings.seek_after_pause],
					"volume_on_play": [my_settings.volume_on_play],
					"flac_header":[my_settings.flac_header],
					"accept_nexturi": [my_settings.accept_nexturi],
					"next_delay": [my_settings.next_delay],
					"keep_alive":[my_settings.keep_alive],
					"send_metadata":[my_settings.send_metadata],
					"send_coverart":[my_settings.send_coverart],
				}	
			],
			"device": []
		}
	}
	let data = await (fs.readFile('./UPnP/Profiles/config.xml', 'utf8'))
	xml2js.parseString(data, async (err,result)=>{
		if(err) {throw err} 
		for await (const [index,device] of result.squeeze2upnp.device.entries()){
			const pid = get_pid(device.name[0])
			if(pid){
				if(my_settings[(device.name[0])]=="HR"){
					device.enabled = ['1']
					device.mode = (("flc:0,r:-192000,s:24").toString().concat(my_settings.flow ?",flow":""))
					device.sample_rate = ['192000'] 
				} else {
					device.enabled = ['1']
					device.mode = (("flc:0,r:-48000,s:16").toString().concat(my_settings.flow ?",flow":""))
					device.sample_rate = ['48000'] 
				}
					let subtemplate = {	"squeeze2upnp": {"common": [{"enabled": ['0']}],"device": [device]}}
					xml_template = builder.buildObject(subtemplate)
					await fs.writeFile("./UPnP/Profiles/"+(device.name[0].replace(/\s/g,""))+".xml",xml_template)
				}
			 else {
				delete result.squeeze2upnp.device[index]
			}				
		}      
		result.squeeze2upnp.common[0]=template.squeeze2upnp.common[0]
		result.squeeze2upnp.common[0].enabled=['0']
		delete result.squeeze2upnp.slimproto_log
		delete result.squeeze2upnp.stream_log
		delete result.squeeze2upnp.output_log
		delete result.squeeze2upnp.decode_log
		delete result.squeeze2upnp.main_log
		delete result.squeeze2upnp.util_log
		delete result.squeeze2upnp.log_limit
		result.squeeze2upnp.device = result.squeeze2upnp.device
		xml_template = builder.buildObject(result)
		await fs.writeFile("./UPnP/Profiles/config.xml",xml_template)
		resolve()
		})
	})
}
async function start_listening() {
	update_status()
	heos_command("system", "prettify_json_response", { enable: "on" }).catch(err=> console.error("ERR 5",err))
}
function update_status() {
	let RheosStatus = '\n' + "RHEOS BRIDGE RUNNING : On " + system_info[2] + ' at ' + system_info[0] + '  for '+ get_elapsed_time(start_time) + '\n\n'  
	RheosStatus - RheosStatus + "_".repeat(120) + "\n \n"
	RheosStatus = RheosStatus + (mode ? "⚠ IN CONFIGURATION MODE - PLEASE SAVE EXTENSION SETTINGS TO ENABLE PLAY MODE"+"\n" : " 🔛 IN PLAY MODE - SELECT SETTINGS TO CONFIGURE" +"\n")
	RheosStatus = RheosStatus + "_".repeat(120) + " \n \n "  + (discovery >0 ? ("CONNECTING HEOS DEVICES TO UPNP"+(".".repeat(discovery ) ))
	: ("DISCOVERED " + rheos_players.size + " HEOS PLAYERS" ))+ "\n \n"
	for (let player of rheos_players.values()) {
		const { name,ip,model} = player
		let quality =  (my_settings[player.name])
		RheosStatus = RheosStatus + (discovery ? "◐" :(quality && quality == "CD") ? "◎  ":"◉ ") +name?.toUpperCase()   + " \t "+ model + "\t" + ip + "\n" //◉
	}
	RheosStatus = RheosStatus + "_".repeat(120)+"\n \n"
	for (let zone of [...rheos_zones.values()].filter(zone => zone.state == "playing")){
		RheosStatus = RheosStatus +"🎶  "+zone.display_name +"\t ▶ \t"+ zone.now_playing.one_line.line1+"\n"
	}
	RheosStatus = RheosStatus + "_".repeat(120)
	svc_status.set_status(RheosStatus, mode)
}
function makelayout(my_settings) {
	const players = [...rheos_players.values()], 
	ips = players.map(player => new Object({"title":player.model+ ' (' +player.name +') '  +' : '+player.ip,"value":player.ip}))
    ips.push({title:"No Default Connection",value: undefined})
	let l = {
		values: my_settings,
		layout: [],
		has_error: false
	}
	l.layout.push(
		ips.length>1
		?
		{type: "dropdown",title: "Default Heos Connection",values: ips,setting: "default_player_ip"	}
		:	
		{type: "string",title: "Default Heos Player IP Address",	maxlength: 15,setting: "default_player_ip"}
	)
	l.layout.push(
		{type: "string",title: "Roon Extension Host IP Address",maxlength: 15,setting: "host_ip"}
	)
	if (players.length) {		
		let _players_status = {type : "group",	title : "PLAYER STATUS",subtitle:" ",	collapsable: false,	items : []}
		players.forEach((player) => {
			if (player){
				_players_status.items.push({
					title: ('◉ ')+player.name.toUpperCase(),
					type : "dropdown",
					values : [{title : "Hi-Resolution",value :"HR"},{title :"CD Quality",value:"CD"}],
					setting : player.name
				})	
			}
		})							
		l.layout.push(_players_status)
	}
	l.layout.push ({type : "group",	title : "ADVANCED SETTINGS (experimantal) ",	collapsable: false,	items : [
		{title:"● Buffer Size",type:"dropdown", setting:'streambuf_size', values:[{title:"Small", value:524288},{title:"Medium", value:524288*2},{title : 'Large',value:524288*3}]},
		{title:"● Output Size",type:"dropdown", setting:'output_size', values:[{title:'Small',value:4194304},{title : 'Medium',value:4194304*2},{title:'Large',value:4194304*3}]},
		{title:"● Stream Length",type:"dropdown", setting:'stream_length', values:[{title: "no length", value:-1},{title:'chunked',value:-3}]},
		{title:"● Seek After Pause",type:"dropdown", setting:'seek_after_pause', values:[{title: "On", value:1},{title:'Off',value:0}]},
		{title:"● Volume On Play",type:"dropdown", setting:'volume_on_play', values:[{title: "On Start Up", value:0},{title:'On Play',value:1},{title:"Never",value:-1}]},
		{title:"● Volume Feedback",type:"dropdown", setting:'volume_feedback', values:[{title: "On", value:0},{title:'Off',value:1},{title:"Never",value:-1}]},
		{title:"● Accept Next URI",type:"dropdown", setting:'accept_nexturi', values:[{title: "Off", value:0},{title:'Force',value:1},{title:"Manual",value:-1}]},
		{title:"● Flac Header",type:"dropdown", setting:'flac_header', values:[{title: "None", value:0},{title:'Set sample and checksum to 0',value:1},{title:"Reinsert fixed",value:2},{title:"Reinsert calculated",value:3}]},
		{title:"● Keep Alive",type:"integer", setting:'keep_alive', min:-1,max:120},
		{title:"● Next Delay",type:"integer", setting:'next_delay',min:0,max:60},
		{title:"● Gapless",type:"dropdown", setting:'flow',values:[{title: "On", value:true},{title:'Off',value:false}]},
		{title:"● Send Metadata",type:"dropdown", setting:'send_metadata', values:[{title: "On", value:1},{title:'Off',value:0}]},
		{title:"● Send Cover Art",type:"dropdown", setting:'send_coverart', values:[{title: "On", value:1},{title:'Off',value:0}]}
	]})
	return (l)
}
function get_pid(player_name) {
	if (rheos_players.size) {
		let player =[...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase() === player_name?.trim().toLowerCase())
		return player?.pid 
	}
}
function get_player(player_name) {
	if (rheos_players.size) {
		let player =[...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase() === player_name?.trim().toLowerCase())
		return player
	}
}
function sum_array(array){
    if (array == undefined  || !isArray(array)) {return 0}
	let total = array?.reduce(function (acc, cur) {return acc + cur}, typeof(array[0])== 'string' ? "" : 0)
	return total
}
function choose_binary(){
	if (os.platform == 'linux') {
		return ('./UPnP/Bin/squeeze2upnp-armv5te-static')	
	} else if (os.platform == 'win32'){
		return('./UPnP/Bin/squeeze2upnp-win.exe')	
	}
}
async function set_permissions(){
	if (os.platform == 'linux') {
		await fs.chmod("./UPnP/Bin/squeeze2upnp-armv5te-static",0o755).catch("ERROR CHANGING MODE")
	}
}
async function group_enqueue(group){
	//console.log("ARRAY & NEW GROUP",queue_array.group,group)
	
	
	
	return new Promise(async (resolve,reject)=>{
	if (queue_array.find(awaited => sum_array(awaited.group)=== sum_array(group))) {
		resolve()
	}
	queue_array.push({group,resolve,reject})	
		


   		
		await group_dequeue().catch(err => console.log("ENQUE ERROR AT ROOT",err))
	})
}
async function group_dequeue(){ 
	if (working) {return}
	const item = queue_array.shift()
	if (!item) {
		//console.log("NO ITEM")
		return 
	}
	try {
		//console.log("SETTING GROUP 1",item.group)queue_array.shift()
		working = true
		//await get_heos_groups()
		let new_group = item.group[0] || item.group
		//console.log("NEW GROUP",new_group)
		let group = rheos_groups.get(new_group)
		//console.log(group)
		 group = group?.players?.length ? group.players?.map(player => player.pid) : []
		//group = group
		//console.log("GROUP",group)
		
		if(sum_array(group) !== sum_array(item.group)){
		//console.log("SETTING GROUP",item.group,"OLD GRP",group)	
		if (item.group.length == 1) {item.group = item.group[0]}
			await heos_command("group","set_group",{pid : item.group.toString()}).catch((err)=> { item.reject(err);working = false;group_dequeue()})
			working = false
			//console.log("SET GROUP",item.group,queue_array.find(awaited => sum_array(awaited.group) == sum_array(item.group)))
			console.log("QUEUE",item.group.toString(),queue_array.map(awaited => awaited.group))
			
			//let res = await get_heos_groups()
			//await group_change()
			//let res2 =await get_heos_groups()
			//console.log("RES @", res)
				//item.resolve ()
				//queue_array.shift()
		        //group_dequeue()
		} //else {
			//console.log("REPEAT GROUP")
			
			item.resolve()
			group_dequeue()
		//}
		//queue_array.shift()
		      //  

	
	}
	catch (err){
		console.log("CAUGHT ERROR",err)
		working = false
		item.reject (err)
		queue_array.shift()
		group_dequeue()
	}
	//return
}

async function get_heos_groups(){
	return new Promise(async function (resolve,reject){
		rheos_groups.clear()
		const res =	await heos_command("group","get_groups").catch(err=> console.error(err)) 
		//console.log("HEOS GROUPS ARE NOW",res.payload)
		if (res.payload.length){
			for (const group of res.payload){
				rheos_groups.set(group.gid,group)
			}
			
		}
		//console.log("MADE HEOS GROUPS",rheos_groups)
		resolve(rheos_groups)
		// else {
		//	rheos_groups.clear()
		//    resolve(rheos_groups)	
		//}	
		
	})
}
function get_elapsed_time (start_time) {
	const end_time = new Date();
	let time_diff = end_time.getTime() - start_time.getTime();
	time_diff = time_diff / 1000;
	const seconds = Math.floor(time_diff % 60)
	time_diff = Math.floor(time_diff / 60)
	const minutes = time_diff % 60
	time_diff = Math.floor(time_diff / 60)
	const hours = time_diff % 24
	time_diff = Math.floor(time_diff / 24)
	const days = time_diff;
	return (days? days + " days,  ":"") + (hours? hours  + " hr ":"") + minutes + " min " + seconds + " sec";
}

/** "UNTESTED STATIC FILES - to be implented"; squeeze2upnp-x86-64-static ;squeeze2upnp-x86-static ;squeeze2upnp-aarch64-static;squeeze2upnp-armv6hf-static;squeeze2upnp-ppc-static;squeeze2upnp-sparc-static;*/
//✪