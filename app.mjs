"use-strict"
import HeosApi from "heos-api"
import RoonApi from "node-roon-api"
import RoonApiSettings from "node-roon-api-settings"
import RoonApiStatus from "node-roon-api-status"
import RoonApiTransport from "node-roon-api-transport"
import child from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import ip from "ip"
import process from "node:process"
import xml2js, { parseStringPromise } from "xml2js"
import util from "node:util"
var roon, svc_status, my_settings, svc_transport, rheos_connection, my_players, my_fixed_groups;
const fixed_groups = new Map()
const all_groups = new Map()
const system_info = [ip.address(), os.type(), os.hostname(), os.platform(), os.arch()]
const rheos = { processes: {}, mode: false, discovery: 0, working: false}
const start_time = new Date()
const queue_array = []
const execFileSync = util.promisify(child.execFile);
const spawn = (child.spawn)
const rheos_players = new Map()
const rheos_zones = new Map()
const rheos_outputs = new Map()
const rheos_groups = new Map()
const builder = new xml2js.Builder({ async: true })
const log = process.argv.includes("-l")||process.argv.includes("-log") || false
init_signal_handlers()
start_up()

async function start_up(){
    console.log(system_info.toString())
	await start_roon().catch(err => console.error(err))
	await start_heos().catch(err => console.error(err))
	await discover_devices().catch(err => {throw error(err)})
    await build_devices().catch(err => console.error("⚠ Error Building Devices",err => {throw error(err)}))
	//await create_players().catch(err => console.error("⚠ Error Creating Players",err => {throw error(err)}))
	await add_listeners().catch(err => console.error("⚠ Error Adding Listeners",err => {throw error(err)}))
	await load_fixed_groups().catch(err => console.error("⚠ Error Loading Fixed Groups",err => {throw error(err)}))
	setTimeout(() => {start_listening().catch(err => console.error("⚠ Error Starting Listening",err => {throw error(err)}))},10000)
}
async function monitor() {
	setInterval(async () => {
		heos_command("system", "heart_beat", {}).catch(err => console.error("⚠  HEARTBEAT MISSED", err))
		update_status(false)
	}, 5000)
	return
}
async function add_listeners() {
	log && console.error("SETTING LISTENERS")
	process.setMaxListeners(32)
	rheos_connection[1].write("system", "register_for_change_events", { enable: "on" })
		.on({ commandGroup: "system", command: "heart_beat" }, async (res) => {
			res?.heos?.result == "success" || console.error("⚠ HEARTBEAT failed", res)
		})
		.onClose(async (hadError) => {
			console.error("⚠ Listeners closed", hadError)
			await start_up().catch(err => { console.error(err) })
		})
		.onError((err) => console.error("⚠ HEOS REPORTS ERROR", err))
		.on({ commandGroup: "event", command: "groups_changed" }, async (res) => {
			await update_heos_groups().catch(err => console.error(err))
			for (const group of rheos_groups.values()) {
				try {
				const players =	group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.network == "leader" ? 0 : 1; return fa - fb} )	
				const zone = rheos_zones.get(rheos_players.get(group.gid)?.zone);
                const new_outputs= players.map(player => rheos_players.get(player.pid)?.output) || []
				const old_outputs = zone?.outputs.map(output => output?.output_id) || []
					if (get_zone_group_value(zone) !== get_heos_group_value(group)) {
						if (new_outputs.length && new_outputs.length > old_outputs?.length) {
							new_outputs && svc_transport.group_outputs(new_outputs)
						}
						else {
							let removed_outputs = old_outputs.filter(op => !new_outputs.includes(op))
							svc_transport.ungroup_outputs(removed_outputs)
						}
				  	} 
				}
				catch {
					console.log("ERROR GETTING PLAYERS",group)
				}
			}
		})
		.on({ commandGroup: "event", command: "players_changed" }, async () => {
			console.log("⚠ PLAYERS HAVE CHANGED - RECONFIGURING")
			start_heos()
		})
		.on({ commandGroup: "event", command: "player_playback_error" }, async (res) => {
			if ( res.heos.message.parsed.error.includes("Unable to play media")){
				svc_transport.control(rheos_players.get(res.heos.message.parsed.pid)?.zone, 'play')
			}
			else {
				console.error("⚠ PLAYBACK ERROR - ATTEMPTING TO PLAY AGAIN", res.heos.message.parsed.error)
			}
		})
		.on({ commandGroup: "event", command: "player_volume_changed" }, async (res) => {
			const { heos: { message: { parsed: { mute, level, pid } } } } = res, player = rheos_players.get(pid)
			if (player?.volume?.mute && (mute != player.volume.mute)) {
				player.volume.mute = mute
				svc_transport.mute(player.output, (mute == 'on' ? 'mute' : 'unmute'))
			}
			if (player?.volume?.level && (level !== player?.volume?.level)) {
				player.volume.level = level
				svc_transport.change_volume(player.output, 'absolute', level)
			}
		})
		.on({ commandGroup: "event", command: "group_volume_changed" }, async (res) => {
			const { heos: { message: { parsed: { mute, level, gid } } } } = res, group = all_groups.get(gid)
			if (group?.players){
				for (let player of group.players){
					const res = await heos_command('player','get_volume',{pid : player.pid})
					const op = (rheos_players.get(player.pid).output)
					svc_transport.change_volume(op, 'absolute', res.parsed.level)
				}
			}
		})
}
async function discover_devices() {
	log && console.log("DISCOVERING DEVICES")
	let message = setInterval(
		function () {
			rheos.discovery++;
			if (rheos.discovery > 29) {
				if (rheos.discovery <300){		
					update_status(
					`⚠ RHEOS ONLY DISCOVERS MARANTZ AND DENON HEOS ENABLE DEVICES
					 ⚠ Unable to discover any HEOS enabled UPnP DEVICES  --- Continuing to search 
					 ⚠ STOPPING RHEOS IN ${300 - rheos.discovery} SECONDS 
					 ◉  TRY ADDING DEFAULT IP FOR A HEOS PLAYER IN SETTINGS 
					 ◉  CHECK ROON EXTENSION PLAYER ADDRESS IS ON SAME NETWORK AS HEOS PLAYERS`, rheos.discovery > 200)
				} else {
					process.exit(0)	
				}		
			} else {
				rheos.mode = true
				update_status(false)
			}
		}, 1000
	)
	return new Promise(async function (resolve, reject) {
		//const players = ([...rheos_players.values()].map(player => player.name))
		let p = await get_players()
		const players = p.map(p => p.name)
			try {
					let data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8')
				
					const slim_devices = await parseStringPromise(data)
					const devices = slim_devices.squeeze2upnp.device.map(d => d.friendly_name[0])
					log && console.log("DEVICES",devices,"PLAYERS",players)
            	if (players.every((player) => {return devices.includes(player)})){	
					clearInterval(message)
					await monitor()
					rheos.discovery=0
					//console.log('MATCHED PLAYERS')
					rheos.mode = false
					update_status(false)
					resolve(data)
				} else {
					console.log("DIFFERENT PLAYERS")
					throw error
				}
			} catch {
				log && console.error("UNABLE TO LOCATE CONFIG FILE")
				await create_root_xml().catch(err => {
					resolve(discover_devices(err))
				})
				clearInterval(message)
				rheos.discovery ++
				resolve ()
			}
	})
}
async function create_root_xml() {
	log && console.error("CREATING ROOT XML")
	const app = await (choose_binary("SYSTEM")).catch(() =>{
		console.error("⚠ BINARY NOT FOUND")
		setTimeout(()=>{process.exit(0)},500)
		}
	)
	return new Promise(async function (resolve,reject) {	
		try {
			log && console.error("CREATING CONFIG FILE")
			rheos.mode = true
			await execFileSync(app, ['-i', './UPnP/Profiles/config.xml', '-b', my_settings.host_ip || ip.address()])
			resolve()
		} 
		catch (err) {
			reject(err)
		}
	})
}
async function start_heos(counter = 0) {
	log && console.log("STARTING HEOS")
	rheos_connection = await  Promise.all([HeosApi.discoverAndConnect({timeout:10000,port:1255, address:ip.address()}),HeosApi.discoverAndConnect({timeout:10000,port:1256, address:ip.address()})])
	try {
		rheos_connection[0].socket.setMaxListeners(32)
		rheos_connection[1].socket.setMaxListeners(32)
		const players = await get_players().catch(()=>{console.error("⚠ Unable to discover Heos Players")})
		roon.save_config("players",players)	
			for (let player of players) {
				player.resolution = my_settings[player.name] || 'CD'
				rheos_players.set(player.pid, player)
				log && console.log("PLAYER SET",player.name)
			}
			players.sort((a, b) => {
					let fa = a.network == "wired" ? 0 : 1
					let fb = b.network == "wired" ? 0 : 1
					return fa - fb
			})
			console.table([...rheos_players.values()], ["name", "pid", "model", "ip", "resolution"])
			await update_heos_groups().catch(err => console.error(err))
			return 			
	}
	catch (err) {
		if (rheos.mode){
		update_status( "⚠ SEARCHING FOR NEW HEOS PLAYERS",false)
		setTimeout(() => {start_heos(++counter)}, 1000)
		}
	}

}
async function get_players() {
	log && console.log("GETTING PLAYERS")
	if (!rheos_connection) {reject("AWAITING CONNECTION")}
	return new Promise(function (resolve, reject) {
		rheos_connection[0]
		.write("player", "get_players", {})
		.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
			switch(true){
				case (players?.payload?.length > 0) : {resolve(players?.payload)}	
				break
				case (players.heos.result === "fail"):reject(players) 			
				break
				case (players.heos.message.unparsed == "command under process"):{
					rheos_connection[0].once({ commandGroup: 'player', command: 'get_players' },(res) => {resolve(res.payload)})
				} 
				break
				default : {reject(players)}
			}
		})
	})
}
async function create_player(pid) {
	let player = rheos_players.get(pid)
	log && console.error("CREATING PLAYER",rheos_players.get(pid.name))
		if (!rheos.processes[pid] || rheos.processes[pid].killed) {
			const name = player.name.replace(/\s/g, "")
			await (fs.truncate('./UPnP/Profiles/' + name + '.log', 0).catch(err => { console.error("Failed to clear log for " + player.name, err)}))
			const app = await (choose_binary(name)).catch(err => console.error("Failed to find binary",err))
			rheos.processes[player.pid] = spawn(app, ['-b', my_settings.host_ip || ip.address(), '-Z', '-M', name,
				'-x', './UPnP/Profiles/' + name + '.xml', 
				'-p','./UPnP/Profiles/' + name + '.pid',
				'-f', './UPnP/Profiles/' + name + '.log'],
					{ stdio: 'ignore' })
		}
	return 
}
async function load_fixed_groups(){
	[...fixed_groups.entries()].forEach( fg => {
		if (my_settings[fg[0]]){
     	if (fg[1]){create_fixed_group(fg[1])}
	}
})
return
}
async function create_fixed_group(group) {
	const hex = Math.abs(get_heos_group_value(group.players.map(p => p.pid))).toString(16);
    const name = group.name
	const mac = "bb:bb:bb:"+ hex.replace(/..\B/g, '$&:').slice(1,7)
	rheos.processes[hex] = spawn('./UPnP/Bin/squeezelite/squeezelite-x64.exe',["-M",name,"-m", mac,"-e","default"])
	return 
}
async function remove_fixed_group(group) {
		const pid= Number(rheos.processes[group]?.pid)
		pid && process.kill( pid ,'SIGTERM')  
   return 
}
async function start_roon() {
	log && console.error("STARTING ROON")
	roon = await connect_roon().catch((err)=> {console.error("Failed to connect with ROON server",err)})
	svc_status = new RoonApiStatus(roon)
	svc_transport = new RoonApiTransport(roon)
	const def = JSON.parse(await fs.readFile('./default_settings.json','utf-8'))
	my_settings = roon.load_config("settings")|| def.settings || {}
	my_players = roon.load_config("players") || []
	let  fg = roon.load_config("fixed_groups") || []
	if (fg.length){my_fixed_groups = JSON.parse(fg)} 
	my_fixed_groups?.forEach(g => fixed_groups.set(g[0],g[1]))
	const svc_settings = new RoonApiSettings(roon, {
		get_settings: async function (cb) {
			cb(makelayout(my_settings))
		},
		save_settings: async function (req, isdryrun, settings) {
			let l = makelayout(settings.values)
			if (l.values.default_player_ip && !l.has_error) {
				await HeosApi.connect(l.values.default_player_ip, 1000).catch(err => (l.has_error = err))
			}
			if (!isdryrun && !l.has_error) {
				update_status()
				for (let fg of all_groups){	
						if (settings.values[fg[0]]){
							fixed_groups.set(fg[0],fg[1])
							create_fixed_group(fg[1])
						}				
			    }
			my_settings = l.values
			my_fixed_groups = JSON.stringify([...fixed_groups.entries()])
			roon.save_config("fixed_groups",my_fixed_groups)
			roon.save_config("settings", my_settings)
			}
			await build_devices().catch(()=>{console.error("Failed to build devices")})
			req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l })
		}
	})
	roon.init_services({
		required_services: [RoonApiTransport], provided_services: [	svc_status,	svc_settings]
	})
	roon.start_discovery()
	return (roon)
}
async function update_outputs(outputs){
	return new Promise(async function (resolve) {
    let player,group
	for (const op of outputs) {	
		rheos_outputs.set(op.output_id,op)
		if (op.source_controls && (player = get_player(op?.source_controls[0]?.display_name))){
			await update_volume(op,get_player(op?.source_controls[0]?.display_name))	
		} else if (op.source_controls  &&    (group = rheos_groups.get(get_pid(rheos_zones.get(op.zone_id)?.outputs[0].source_controls[0].display_name)))){
			await update_group_volume(op,group)
		}
	}
	resolve()
	}).catch(err => console.error(err))
}
async function update_zones(zones){
	return new Promise(async function (resolve) {
	for (const z of zones) {
		const old_zone =  rheos_zones.get(z.zone_id)
		if (z.outputs){
			let last_el = z.outputs.flatMap(output => output.source_controls).flatMap(control => control.display_name).slice(-1)
			let fixed = [...fixed_groups.values()].find(group => last_el == group.name)?.players.map(player => rheos_players.get(player.pid)?.output).filter (o => o)
			//const lead_player_pid = get_pid(z.outputs[0]?.source_controls[0]?.display_name)
			rheos_zones.set(z.zone_id, z)	
			if (fixed){
				const op = z.outputs[z.outputs.length-1]
				const group = [...fixed_groups.values()].find(group => z.outputs[z.outputs.length-1].source_controls[0]?.display_name == group.name)?.players.map(player => player.pid)
				const rheos_group = [...rheos_groups.values()].find(r_group => r_group.sum_group == sum_array(group))
				fixed && fixed.push(op.output_id)
				if(group &&(z.state == 'playing' && (old_zone?.state == "stopped" || old_zone?.state == "paused" || ! old_zone?.state))&& !fixed.includes(undefined)) {		
					if (!rheos_group)	{
						await group_enqueue(group)
					}
					svc_transport.group_outputs(fixed)
					play_zone(fixed[0])				
				}else if(group &&(z.state=='paused') && (old_zone?.state == 'playing' ) ){	
					svc_transport.ungroup_outputs(fixed)
					group_enqueue(group[0])
					rheos_groups.delete(group[0])
				} 
			}
			else {
				const group = (rheos_groups.get(get_pid(z.outputs[0]?.source_controls[0]?.display_name)))
				const old_roon_group = old_zone?.outputs?.map(output => get_pid(output.source_controls[0].display_name))
				const new_roon_group = (z.outputs.map(output => get_pid(output.source_controls[0].display_name)))
				const heos_group = group?.players.map(player => player.pid);
				if ((sum_array(old_roon_group) !== sum_array(new_roon_group))  && (sum_array(new_roon_group) !== sum_array(heos_group))) {
					group_enqueue(new_roon_group)
				}	
			} 
			z.state == 'paused' || z.state == 'stopped' || (old_zone?.now_playing?.one_line?.line1 == z?.now_playing?.one_line?.line1 ) ||  console.error(new Date().toLocaleString(), z.display_name, " ▶ ",z?.now_playing?.one_line?.line1)
		} else {  
			const zone =(rheos_zones.get(z))
			if (zone?.outputs.filter(op => get_pid(op.source_controls[0].display_name)).length >1){
				const lead_player_pid = get_pid(zone.outputs[0]?.source_controls[0]?.display_name)
				const group = (rheos_groups.get(lead_player_pid))
				if (group?.gid) { 	
					await group_enqueue(group.players.map(player => player.pid))
				}
			}	
			rheos_zones.delete(z)
		}
	}
	resolve()
	}).catch(err => console.error(err))
}

async function play_zone(op){
	setTimeout(()=>{
		svc_transport.control((svc_transport.zone_by_output_id(op)),'play') 
	},my_settings.fixed_group_delay || 3000)
}
async function update_volume(op,player){
	if (op && player && (player?.volume?.mute !== (op?.volume?.is_muted ? "on" : "off")) && op?.volume?.is_muted !== player?.output?.volume?.is_muted) {
		player.volume = { level: op?.volume?.value, mute: op?.volume?.is_muted ? "on" : "off" }
		await heos_command("player", "set_mute", { pid: player?.pid, state: op?.volume?.is_muted ? "on" : "off" }).catch(err => console.error(err))
	}
	else if (op && player && player?.volume?.level !== op?.volume?.value && op?.volume?.value !== player?.output?.volume?.value) {
		player.volume = { level: op?.volume?.value, mute: op?.volume?.is_muted ? "on" : "off" }
		await heos_command("player", "set_volume", { pid: player.pid, level: op.volume.value }).catch(err => console.error(err))
	}
	(player && op) && (player.output = op.output_id) && (player.zone = op.zone_id)
}

async function update_group_volume(op,group){
	    group?.gid && await heos_command("group", "set_volume", { gid: group.gid, level: op.volume.value }).catch(err => console.error(err))
		group?.gid && await heos_command("group", "set_mute", { gid: group.gid, state: op.volume.is_muted ? "on" : "off" }).catch(err => console.error(err))
}
async function heos_command(commandGroup, command, attributes = {}, timer = 5000) {
	if (!rheos_connection) {
		console.error("NO CONNECTION")
		return
	}
	typeof attributes === "object" || ((timer = attributes), (attributes = {}))
	return new Promise(function (resolve, reject) {
		setTimeout(() => {reject(`Heos command timed out: ${command} ${timer}`) }, timer)
		commandGroup !== "event" && rheos_connection[0].write(commandGroup, command, attributes)
		rheos_connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
			res.parsed = res.heos.message.parsed
			res.result = res.heos.result
			if (res.heos.message.unparsed.includes("under process")) {
				rheos_connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
				resolve(res)
			})} 
			else if (res.heos.result === "success") {
				resolve(res)}
			else {
				reject(res)	
			}		
		})
	}).catch((err)=> err)
}
async function build_devices() {
	log && console.log("BUILDING DEVICES")
	return new Promise(async function (resolve) {
		let template, xml_template = {}
		template = {
			"squeeze2upnp": {
				"common": [
					{
						"enabled": ['0'],
						"streambuf_size": [my_settings.streambuf_size],
						"output_size": [my_settings.output_size],
						"stream_length": [my_settings.stream_length],
						"codecs": ["aac,ogg,flc,alc,pcm,mp3"],
						"forced_mimetypes": ["audio/mpeg,audio/vnd.dlna.adts,audio/mp4,audio/x-ms-wma,application/ogg,audio/x-flac"],
						"mode": [("flc:0,r:-48000,s:16").toString().concat(my_settings.flow ? ",flow" : "")],
						//"mode": ["thru"],
						"raw_audio_format": ["raw,wav,aif"],
						"sample_rate": ['48000'],
						"L24_format": ['2'],
						"roon_mode": ['1'],
						"seek_after_pause": [my_settings.seek_after_pause],
						"volume_on_play": [my_settings.volume_on_play],
						"flac_header": [my_settings.flac_header],
						"accept_nexturi": [my_settings.accept_nexturi],
						"next_delay": [my_settings.next_delay],
						"keep_alive": [my_settings.keep_alive],
						"send_metadata": [my_settings.send_metadata],
						"send_coverart": [my_settings.send_coverart],
						"flow":[my_settings.flow]
					}
				],
				"device": []
			}
		}
		let data = await (fs.readFile('./UPnP/Profiles/config.xml', 'utf8'))
		xml2js.parseString(data, async (err, result) => {
			if (err) { throw err }
			if (!result?.squeeze2upnp?.device?.entries()) {
				console.error("NO DEVICE ENTRIES")
				return
			}
			for await (const [index, device] of result?.squeeze2upnp?.device?.entries()) {
				log && console.log("Building",device.name)
				const pid = get_pid(device.name[0])
				if (pid) {
					if (my_settings[(device.name[0])] == "HR") {
						device.enabled = ['1']
						device.mode = ("flc:0,r:-192000,s:24").toString().concat(my_settings.flow ? ",flow" : "")
						device.sample_rate = ['192000']
					} 
					else if (my_settings[(device.name[0])] == "thru") {
						device.enabled = ['1']
						device.mode = "thru"
						device.sample_rate = ['192000']
					}
					else {
						device.enabled = ['1']
						device.mode = ("flc:0,r:48000,s:16").toString().concat(my_settings.flow ? ",flow" : "")
						device.sample_rate = ['48000']
					}
					let subtemplate = { "squeeze2upnp": { "common": template.squeeze2upnp.common, "device": [device] } }
					xml_template = builder.buildObject(subtemplate)
					await fs.writeFile("./UPnP/Profiles/" + (device.name[0].replace(/\s/g, "")) + ".xml", xml_template).catch(()=>{console.error("⚠ Failed to create template for "+device.name[0])})
				    create_player(pid)
				}
				else {
					delete result.squeeze2upnp.device[index]
				}
			}
			result.squeeze2upnp.common[0] = template.squeeze2upnp.common[0]
			result.squeeze2upnp.common[0].enabled = ['0']
			delete result.squeeze2upnp.slimproto_log
			delete result.squeeze2upnp.stream_log
			delete result.squeeze2upnp.output_log
			delete result.squeeze2upnp.decode_log
			delete result.squeeze2upnp.main_log
			delete result.squeeze2upnp.util_log
			delete result.squeeze2upnp.log_limit
			result.squeeze2upnp.device = result.squeeze2upnp.device
			xml_template = builder.buildObject(result)
			await fs.writeFile("./UPnP/Profiles/config.xml", xml_template).catch(()=>{console.error("⚠ Failed to save config")})
			rheos.mode = false
			update_status()
			resolve()
		})
	})
}
async function start_listening() {
	update_status(false)
	await heos_command("system", "prettify_json_response", { enable: "on" }).catch(err => console.error("⚠ Failed to set responses"))
}
async function choose_binary(name) {
	log && console.log("LOADING BINARY for",name, os.platform())
	if (os.platform() == 'linux') {
		try {
					if (os.arch() === 'arm'){
			log && console.error("LOADING armv6")
			await fs.chmod('./UPnP/Bin/RHEOS-armv6', 0o111)
			return ('./UPnP/Bin/RHEOS-armv6')
		} else if (os.arch() === 'arm64'){
			await fs.chmod('./UPnP/Bin/RHEOS-arm', 0o111)
			log && console.error("LOADING arm")
			return('./UPnP/Bin/RHEOS-arm')
		} else if (os.arch() === 'x64'){ 
			log && console.error("LOADING x64")
			await fs.chmod('./UPnP/Bin/RHEOS-x86-64', 0o111)
			return('./UPnP/Bin/RHEOS-x86-64')
		} else if (os.arch() === 'ia32'){
			log && console.error("LOADING ia32")
			await fs.chmod('./UPnP/Bin/RHEOS-x86', 0o111)
			return('./UPnP/Bin/RHEOS-x86')
		}
		} catch {
			console.error("UNABLE TO LOAD LINUX BINARIES - ABORTING")
			process.exit(0)
		}

	}
	else if (os.platform() == 'win32') {
		log && console.error(" LOADING WINDOWS EXE")
		return('./UPnP/Bin/RHEOS2UPNP.exe')
	} 
	else if (os.platform() == 'darwin') {
		log && console.error("ATTEMPTING LOADING MAC OS")
		try {
			await fs.chmod('./UPnP/Bin/RHEOS-macos-x86_64-static', 0o111)
			log && console.error("LOADING MAC BINARIES x86_64")
			return('./UPnP/Bin/RHEOS-macos-x86_64-static')} 
		catch {
          	console.error("UNABLE TO LOAD MAC BINARIES - ABORTING")
		  	process.exit(0)
		}
	}
	else {
		console.error("THIS OPERATING SYSTEM IS NOT SUPPORTED");
	 	process.exit(0)
	}
}
async function group_enqueue(group) {
	Array.isArray(group) && (group = group.filter(o => o))
	if (!group) {
		return 
	}
	return new Promise(async (resolve, reject) => {
		if (queue_array.length){
        	for (let queued_group of queue_array){
 				let checkSubset = (group) => {return group.every((player) => {return queued_group.includes(player)})}
				if (checkSubset){
					resolve()
				} else {
					queue_array.push({ group, resolve, reject })
				}
			}
		} else {
			queue_array.push({ group, resolve, reject })
		}
		group_dequeue().catch((err)=>{log && console.error("Deque error",err)})
	})
}	
async function group_dequeue(timer = 30000) {
	if (rheos.working || !queue_array.length) { 
		return }
	const item = queue_array[0]
	if (!item) {
		return
	}
	try {
		rheos.working = true
		if (![...rheos_groups.values()].includes( sum_array(item))){
			await heos_command("group", "set_group", { pid: item?.group?.toString() },timer).catch((err) => {item.reject(err); rheos.working = false; group_dequeue() })
		}
		rheos.working = false 
		queue_array.shift()
		item.resolve()
		await group_dequeue()
	}
	catch (err) {
		rheos.working = false
		queue_array.shift()
		item.reject(err)
		await group_dequeue()
	}
	return
}
async function update_heos_groups() {
	return new Promise(async function (resolve) {
		let old_groups = [...rheos_groups.keys()]
		rheos_groups.clear()
		const res = await heos_command("group", "get_groups",3000).catch(err => console.error(err))
		if (res?.payload?.length) {
			for (const group of res.payload) {
				group.sum_group = sum_array(group.players.map(player => player.pid))
				rheos_groups.set(group.gid, group)	
			}
			const remove = old_groups.filter(group => !rheos_groups.has(group))
			svc_transport.ungroup_outputs(rheos_zones.get((rheos_players.get(remove[0])?.zone))?.outputs)
		
		} else {
            const remove = old_groups
			svc_transport.ungroup_outputs(rheos_zones.get((rheos_players.get(remove[0])?.zone))?.outputs)
		}
		get_all_groups()
		resolve(res)
	}).catch(err => console.error(err))
}
async function connect_roon() {
	return new Promise(async function (resolve,reject) {
	const timer = setInterval(() => console.warn(" ⚠ Please ensure RHEOS is enabled in Settings -> Extensions"), 10000)
	const roon = new RoonApi({
		extension_id: "com.RHeos.beta",
		display_name: "Rheos",
		display_version: "0.6.1-2",
		publisher: "RHEOS",
		email: "rheos.control@gmail.com",
		website: "https:/github.com/LINVALE/RHEOS",
		log_level: "none",
		core_paired: async function (core) {
			log && console.log("ROON PAIRED")
			clearInterval(timer)
			svc_transport = core.services.RoonApiTransport
			svc_transport.subscribe_outputs(async function (cmd, data) {	
				switch (cmd){
					case "Network Error" : 	
						await start_roon()
						for (const z of data.zones) {
							rheos_outputs.set(z.zone_id, z)
						}
						break			
					case "Changed" : {
						Array.isArray(data.outputs_changed) && await update_outputs(data.outputs_changed)
						Array.isArray(data.outputs_added) && await update_outputs(data.outputs_added)
						Array.isArray(data.outputs_removed) && await update_outputs(data.outputs_removed)
					}
				}
			})
			svc_transport.subscribe_zones(async function (cmd, data) {
				switch(cmd){
					case "Subscribed" : 
						for (const z of data.zones) {
							rheos_zones.set(z.zone_id, z)
						    log && console.log("ZONE SUBSCRIBED",z.display_name)
						}
						break
					case "Changed" : {	
						Array.isArray(data.zones_added) && log && console.log("ZONES ADDED", data.zones_added.map( z=>z.display_name))
						Array.isArray(data.zones_removed) && await update_zones(data.zones_removed);	
						Array.isArray(data.zones_added) && await update_zones(data.zones_added);
						Array.isArray(data.zones_changed) && await update_zones(data.zones_changed);
					}		
				}
			})
		},
		core_unpaired: async function (core) {
			core = undefined
		}
	})
	if (roon){
	
	resolve (roon)}
	else{
		console.error("NO ROON FOUND");
		reject
	}
})
}

async function update_status(message = "",warning = false) {
	
	
	let RheosStatus = rheos_players.size + " HEOS Players on " + system_info[2] +" "+ system_info [3]+" "+ system_info [4] + ' at ' + system_info[0] + '  for ' + get_elapsed_time(start_time) + '\n'
    if (rheos.mode){
	//if (message){
	//	svc_status.set_status(RheosStatus, warning)
	//}else {
	
		RheosStatus = RheosStatus + "_".repeat(120) + " \n \n " + (rheos.discovery > 0 ? ("⚠      UPnP CONNECTING       " + ("▓".repeat((rheos.discovery))+"░".repeat(30-rheos.discovery)))
		: ("DISCOVERED " + rheos_players.size + " HEOS PLAYERS")) + "\n \n"
		for (let player of rheos_players.values()) {
		const { name, ip, model } = player
		let quality = (my_settings[player.name])
		RheosStatus = RheosStatus + (rheos.discovery ? "◐◓◑◒".slice(rheos.discovery % 4, (rheos.discovery % 4) + 1) + " " : (quality === "HR")  ?"◉  " :"◎  " ) + name?.toUpperCase() + " \t " + model + "\t" + ip + "\n"
		}
		RheosStatus = RheosStatus //+ "_".repeat(120) + "\n \n"
	//}
	}
	for (let zone of [...rheos_zones.values()].filter(zone => zone.state == "playing")) {
		RheosStatus = RheosStatus + "🎶  " + zone.display_name + "\t ▶ \t" + zone.now_playing.one_line.line1 + "\n"
	}
	//rheos.mode && (RheosStatus = RheosStatus)
	
	
svc_status.set_status(RheosStatus, warning)
}
function makelayout(my_settings) {
	const players = [...rheos_players.values()],
	ips = players.map(player => new Object({ "title": player.model + ' (' + player.name + ') ' + ' : ' + player.ip, "value": player.ip }))
	ips.push({ title: "No Default Connection", value: undefined })
	let l = {
		values: my_settings,
		layout: [],
		has_error: false
	}
	l.layout.push(
		ips.length > 1
			?
			{ type: "dropdown", title: "Default Heos Connection", values: ips, setting: "default_player_ip" }
			:
			{ type: "string", title: "Default Heos Player IP Address", maxlength: 15, setting: "default_player_ip" }
	)
	l.layout.push(
		{ type: "string", title: "Roon Extension Host IP Address", maxlength: 15, setting: "host_ip" }
	)
	if (players.length) {
		let _players_status = { type: "group", title: "PLAYERS", subtitle: " ", collapsable: true, items: [] }
		players.forEach((player) => {
			if (player) {
				_players_status.items.push({
					title: ('◉ ') + player.name.toUpperCase(),
					type: "dropdown",
					values: [{ title: "Hi-Resolution", value: "HR" }, { title: "CD Quality", value: "CD" },{ title: "Pass Through", value: "thru" }],
					setting: player.name
				})
			}
		})
		l.layout.push(_players_status)
	}
	
	let _fixed_groups = { type: "group", title: "GROUPS", subtitle: " ", collapsable: true, items: [] };
		    _fixed_groups.items.push({title:"Fixed Group Start Delay",type:"dropdown",values:[
				{title: "MIN",value : 1000},
				{title: '+', value : 2000},
				{title: '++',value : 3000},
				{title: '+++', value : 4000},
				{title: '++++',value : 5000},
				{title: "MAX",value : 10000}],
				setting : 'fixed_group_delay'})
			for (let group of all_groups.entries()) {
			if (group) {
				let name = group[1].players.map(player=>player.name).toString()
				let values = []
				values.push({title: "FIXED", value: true})	
				values.push({title: "VARIABLE", value: false})
				_fixed_groups.items.push({
					title: name,
					type: "dropdown",
					values: values, 
					setting: group[0]
				})
			}
		}
		l.layout.push(_fixed_groups)
	l.layout.push({
		type: "group", title: "ADVANCED (experimantal) ", collapsable: true, items: [
			{ title: "● Buffer Size", type: "dropdown", setting: 'streambuf_size', values: [{ title: "Small", value: 524288 }, { title: "Medium", value: 524288 * 2 }, { title: 'Large', value: 524288 * 3 }] },
			{ title: "● Output Size", type: "dropdown", setting: 'output_size', values: [{ title: 'Small', value: 4194304 }, { title: 'Medium', value: 4194304 * 2 }, { title: 'Large', value: 4194304 * 3 }] },
			{ title: "● Stream Length", type: "dropdown", setting: 'stream_length', values: [{ title: "no length", value: -1 }, { title: 'chunked', value: -3 }] },
			{ title: "● Seek After Pause", type: "dropdown", setting: 'seek_after_pause', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
			{ title: "● Volume On Play", type: "dropdown", setting: 'volume_on_play', values: [{ title: "On Start Up", value: 0 }, { title: 'On Play', value: 1 }, { title: "Never", value: -1 }] },
			{ title: "● Volume Feedback", type: "dropdown", setting: 'volume_feedback', values: [{ title: "On", value: 0 }, { title: 'Off', value: 1 }, { title: "Never", value: -1 }] },
			{ title: "● Accept Next URI", type: "dropdown", setting: 'accept_nexturi', values: [{ title: "Off", value: 0 }, { title: 'Force', value: 1 }, { title: "Manual", value: -1 }] },
			{ title: "● Flac Header", type: "dropdown", setting: 'flac_header', values: [{ title: "None", value: 0 }, { title: 'Set sample and checksum to 0', value: 1 }, { title: "Reinsert fixed", value: 2 }, { title: "Reinsert calculated", value: 3 }] },
			{ title: "● Keep Alive", type: "integer", setting: 'keep_alive', min: -1, max: 120 },
			{ title: "● Next Delay", type: "integer", setting: 'next_delay', min: 0, max: 60 },
			{ title: "● Send Metadata", type: "dropdown", setting: 'send_metadata', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
			{ title: "● Send Cover Art", type: "dropdown", setting: 'send_coverart', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
			{ title: "● Flow Mode", type: "dropdown", setting: 'flow', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] }
		]
	})
	return (l)
}
function get_zone_group_value(zone_id){
	const zone = rheos_zones.get(zone_id) || rheos_zones.get(zone_id?.zone_id) || false
	if (!zone) {return}
	return( sum_array(zone.outputs.map(o => get_pid(o.source_controls[0].display_name)))) 
}
function get_heos_group_value(group =''){	
	let selected = 0
	if (Array.isArray(group.players)){	
        selected =(sum_array(group?.players.map(player => player.pid)))
	} else if (Array.isArray(group)){
		selected=(sum_array(group))
    } 
		else if (group.includes ("+")){
			selected = sum_array(group?.split(' + ').map(player => player?.pid ||  get_pid(player)))
		} else  if (group.includes ("+")){

 		selected = sum_array(group?.split(',').map(player => player?.pid ||  get_pid(player )))
	}
	return(selected)
}
function get_pid(player_name) {
	if (rheos_players.size) {
		let player = [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase().replace(/\s/g, "") === player_name?.trim().toLowerCase().replace(/\s/g, ""))
		return player?.pid || 0
	}
}
function get_player(player_name) {
	if (rheos_players.size) {
		let player = [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase().replace(/\s/g, "") === player_name?.trim().toLowerCase().replace(/\s/g, ""))
		return player
	}
}
function sum_array(array) {
	if (array == undefined || !Array.isArray(array)) { return 0 }
	let total = array?.reduce(function (acc, cur) { return acc + cur }, typeof (array[0]) == 'string' ? "" : 0)
	return total
}
function get_all_groups(){
	for (const group of fixed_groups){
		all_groups.set(get_heos_group_value(group[1]),group[1])
	}
	for (const group of rheos_groups){
		all_groups.set(get_heos_group_value(group[1]),group[1])
	}
}
function get_elapsed_time(start_time) {
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
	return (days ? days + (days == 1 ? " day " : " days " ) : "") + (hours ? hours + ' hour'+ (hours === 1 ? "  " : "s " ) : "") + minutes + (minutes === 1 ? " minute ":" minutes ") + seconds +(seconds === 1 ? " second " : " seconds ");
}
function init_signal_handlers() {
    const handle = function(signal) {
		console.log("\r\nRHEOS IS SHUTTING DOWN")
			for (let key of Object.keys(rheos.processes)){
				process.kill(Number(rheos.processes[key].pid),9)
			}
        process.exit(0);
    };
    process.on('SIGTERM', handle);
    process.on('SIGINT', handle);
}


