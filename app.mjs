const version = "0.6.5-6"
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
import process, { pid } from "node:process"
import xml2js, { parseStringPromise } from "xml2js"
import util from "node:util"

var roon, svc_status, my_settings, svc_transport, rheos_connection, my_players, my_fixed_groups, squeezelite;
const fixed_groups = new Map()
const all_groups = new Map()
const system_info = [ip.address(), os.type(), os.hostname(), os.platform(), os.arch()]
const rheos = { processes: {}, mode: false, discovery: 0, working: false}
const start_time = new Date()
const queue_array = []
const execFileSync = util.promisify(child.execFile);
const exec = (child.exec)
const spawn = (child.spawn)
const rheos_players = new Map()
const rheos_zones = new Map()
const rheos_outputs = new Map()
const rheos_groups = new Map()
const play_pending = []
const builder = new xml2js.Builder({ async: true })
const log = process.argv.includes("-l")||process.argv.includes("-log") || false
init_signal_handlers()

start_up()

async function start_up(){
	exec("pkill -f -9 UPnP")
	exec("pkill -f -9 squeezelite")
    squeezelite = "squeezelite"
	await start_roon().catch(err => console.error(err))
	console.log(system_info.toString(),roon.extension_reginfo.display_version)
	const c = spawn("squeezelite")
		c.on('error', async function(err) {
		console.error('SQUEEZLITE NOT INSTALLED : LOADING BINARIES');
		squeezelite = await choose_binary("squeezelite",true)
	})
	await start_heos().catch(err => console.error(err))
	await discover_devices().catch(err => {throw error(err)})
    await build_devices().catch(err => console.error("⚠ Error Building Devices",err => {throw error(err)}))
	await add_listeners().catch(err => console.error("⚠ Error Adding Listeners",err => {throw error(err)}))
	await load_fixed_groups().catch(err => console.error("⚠ Error Loading Fixed Groups",err => {throw error(err)}))
	monitor()
	setTimeout(() => {start_listening().catch(err => console.error("⚠ Error Starting Listening",err => {throw error(err)}))},10000)
}
async function monitor() {
	setInterval(async () => {
		heos_command("system", "heart_beat", {}).catch(err => console.error("⚠  HEARTBEAT MISSED", err))
		update_status("OK",false)
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
		.on({ commandGroup: "event", command: "groups_changed" }, async () => {
			log &&console.log("GROUPS CHANGED")
			await update_heos_groups().catch(err => console.error(err))
			for (const group of rheos_groups.values()) {
				if (group.players.find(player => player.role == "leader")){
				try {
				const players =	group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} )	
				const zone = rheos_zones?.get(rheos_players.get(group.gid)?.zone);
                const new_outputs= players?.map(player => rheos_players.get(player.pid)?.output) || []
				const old_outputs = zone?.outputs.map(output => output?.output_id) || []
					if (get_zone_group_value(zone) !== get_heos_group_value(group)) {
						if (new_outputs?.length && new_outputs?.length > old_outputs?.length) {
							new_outputs && svc_transport.group_outputs(new_outputs)
						}
						else {
							let removed_outputs = old_outputs?.filter(op => !new_outputs?.includes(op))
							svc_transport.ungroup_outputs(old_outputs)
						}
				  	} 
                    let index = play_pending.indexOf(zone?.outputs[zone?.outputs.length-1].output_id)
					if (index !== -1){
						svc_transport.control(zone,"play")
						play_pending.splice(index,1)
					}
				}
				catch {
					log &&console.error("⚠ GROUPS CHANGED : ERROR GETTING PLAYERS",group)
				}
			}else {
				log && console.error("⚠ GROUPS CHANGED : NO GROUP LEADER",group)
				}
			}
		})
		.on({ commandGroup: "event", command: "players_changed" }, async (res) => {
			log &&console.log("⚠ PLAYERS HAVE CHANGED - RECONFIGURING",res)
			clearTimeout(rheos.player_changed_timer)
			rheos.player_changed_timer = setTimeout(async ()=>{await compare_players()},1000)
		})
		.on({ commandGroup: "event", command: "player_playback_error" }, async (res) => {
			if ( res.heos.message.parsed.error.includes("Unable to play media")){
				svc_transport.control(rheos_players.get(res.heos.message.parsed.pid)?.zone, 'play')
			}
			else {
				console.error("⚠ PLAYBACK ERROR - ATTEMPTING TO PLAY AGAIN", res.heos.message.parsed.error)
				svc_transport.control(rheos_players.get(res.heos.message.parsed.pid)?.zone, 'play')
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
			const { heos: { message: { parsed: { mute, level, gid } } } } = res, group = rheos_players.get(gid)
			if (group?.players){
				for (let player of group.players){
					const res = await heos_command('player','get_volume',{pid : player.pid})
					const op = (rheos_players.get(player.pid).output)
					svc_transport.change_volume(op, 'absolute', res.parsed.level)
				}
			}
		})
		.on({ commandGroup: "event", command: "player_state_changed" }, async (res) => {
			const { heos: { message: { parsed: { pid,state} } } } = res
			const player = rheos_players.get(pid)
            const fixed = [...fixed_groups.values()].find(group => group.gid == player?.pid)
            if (fixed ){
				fixed.state = state
				if (state == "pause") {
                    await group_enqueue([pid])
				}			
			}
			player && (player.state = state) && log && console.log("PLAYER STATE CHANGED",player.name,state) 
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
					`⚠ RHEOS ONLY DISCOVERS MARANTZ AND DENON HEOS ENABLED DEVICES
					 ⚠ Unable to discover any HEOS enabled UPnP DEVICES  --- Continuing to search 
					 ⚠ STOPPING RHEOS IN ${300 - rheos.discovery} SECONDS 
					 ◉  TRY ADDING DEFAULT IP FOR A HEOS PLAYER IN SETTINGS 
					 ◉  CHECK ROON EXTENSION PLAYER ADDRESS IS ON SAME NETWORK AS HEOS PLAYERS`, rheos.discovery > 200)
				} else {
					process.exit(0)	
				}		
			} else {
				rheos.mode = true
				update_status("DISCOVERING PLAYERS",false)
			}	
		}, 1000
	)
	return new Promise(async function (resolve) {
		const players = await get_players()
			try {
				    log && console.log('READING PROFILES CONFIG')
					const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8')
					const slim_devices = await parseStringPromise(data)
					const devices = slim_devices.squeeze2upnp.device.map(d => d.friendly_name[0])
					log && console.log("DEVICES",devices,"PLAYERS",players)
            	if (players.length && players.every((player) => {return devices.includes(player.name)})){	
					clearInterval(message)
					await monitor()
					rheos.discovery=0
					rheos.mode = false
					resolve()
				} else {
					log && console.log("DIFFERENT PLAYERS")
					throw error
				}
			} catch {
				log && console.error("UPDATING CONFIG FILE")
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
		log && console.error("⚠ BINARY NOT FOUND")
		setTimeout(()=>{process.exit(0)},500)
	})
	return new Promise(async function (resolve,reject) {	
		try {
			log && console.error("CREATING CONFIG FILE FROM IP", ip.address())
			rheos.mode = true
			let app = await choose_binary()		
			await execFileSync(app, ['-i', './UPnP/Profiles/config.xml', '-b', ip.address()])	
			resolve()
		} 
		catch {
			reject(err)
		}
	})
}
async function start_heos(counter = 0) {
	console.log("STARTING HEOS")
	rheos_connection || (rheos_connection = await  Promise.all([HeosApi.discoverAndConnect({timeout:10000,port:1255, address:ip.address()}),HeosApi.discoverAndConnect({timeout:10000,port:1256, address:ip.address()})]))
	try {
		rheos_connection[0].socket.setMaxListeners(32)
		rheos_connection[1].socket.setMaxListeners(32)
		const players = await get_players().catch(()=>{console.error("⚠ Unable to discover Heos Players")})
		roon.save_config("players",players)	
			for (let player of players) {
				player.resolution = my_settings[player.pid] || 'CD'
				player.pid && rheos_players.set(player.pid, player)
				log && console.log("PLAYER SET",player.name)
			}
			players.sort((a, b) => {
					let fa = a.network == "wired" ? 0 : 1
					let fb = b.network == "wired" ? 0 : 1
					return fa - fb
			})
			console.table([...rheos_players.values()], ["name", "pid", "model", "ip", "resolution"])
			await update_heos_groups().catch(err => console.error(err))
			return 	(players)		
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
	return new Promise(function (resolve, reject) {
		if (!rheos_connection) {reject("AWAITING CONNECTION")}
		rheos_connection[1]
		.write("player", "get_players", {})
		.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
			switch(true){
				case (players?.payload?.length > 0) : {resolve(players?.payload)}	
				break
				case (players.heos.result === "fail"):reject() 			
				break
				case (players.heos.message.unparsed == "command under process"):{
					{console.log(players);resolve(get_players())}
				} 
				break
				default : {reject()}
			}
		})
	})
}
async function compare_players(){
	log && console.log('GETTING PLAYERS TO COMPARE')
	const old_pids = [...rheos_players.keys()]
	const new_players = await get_players()
	const new_pids = new_players.map(p => p?.pid)
	const newp =  new_pids.filter(new_pid => !old_pids.includes(new_pid))
	const delp =  old_pids.filter(old_pid => !new_pids.includes(old_pid))
	if (delp.length) {
		delp.forEach( (d)=>{
			process.kill(Number(rheos.processes[d].pid,'SIGKILL'))
			delete rheos.processes[d]	
		})
	}
	if (newp.length){
		newp.forEach((p)=> {
			rheos_players.set (p, new_players.find(player => player.pid == p))
			create_player(p)	
		})
	} 
}
async function create_player(pid) {
	if (rheos.processes[pid]) {
		process.kill(Number(rheos.processes[pid].pid),'SIGKILL')
	}
	const player = rheos_players.get(pid)
	const name = player.name.replace(/\s/g, "")
	log && console.log("CREATING BINARY FOR",player.name)
	await (fs.truncate('./UPnP/Profiles/' + name + '.log', 0).catch(err => { log && console.error("Failed to clear log for " + player.name)}))
	const app = await (choose_binary(name)).catch(err => console.error("Failed to find binary",err))
	rheos.processes[player.pid] = spawn(app, ['-b', ip.address(), '-Z', '-M', name,
		'-x', './UPnP/Profiles/' + name + '.xml', 
		'-p','./UPnP/Profiles/' + name + '.pid',
		'-f', './UPnP/Profiles/' + name + '.log']),
		{ stdio: 'ignore' }
		log && console.log(rheos.processes[player.pid].spawnargs[5])
	return 
}
async function load_fixed_groups(){
	log && console.log("LOADING FIXED GROUPS",fixed_groups);
	fixed_groups.size &&
	[...fixed_groups.entries()].forEach( async fg => {
		if (fg && my_settings[fg[0]] && fg[1]){
			create_fixed_group(fg)
		}
	})
}
async function create_fixed_group(group){
	log && console.log("CREATING FIXED GROUP",group)
	const hex = Math.abs(group[0]).toString(16);
	if (rheos.processes[hex]?.pid){
		try { 
			process.kill( rheos.processes[hex]?.pid,'SIGKILL') 
			fixed_groups.delete(g)
			get_all_groups()
		} catch { log && console.log("UNABLE TO DELETE PROCESS FOR"),group}	
		
	}
    const name = group[1].name.split("+")
	const display_name = "🔗 " +name[0].trim()+" + " + (name.length)
	group[1].display_name = display_name
	fixed_groups.set(group[0],group[1])
	const mac = "bb:bb:bb:"+ hex.replace(/..\B/g, '$&:').slice(1,7)
	log && console.log("SPAWNING SQUEEZELITE",display_name,mac,hex,group[1].resolution +" : 500")
	rheos.processes[hex] = spawn(squeezelite,["-a","24","-r",group[1].resolution +" : 500","-M",display_name,"-m", mac,"-o","-"])
	if (rheos_groups.get(group[1].gid)){
		console.log("UN GROUPING",[group[1].gid][0])
		await group_enqueue([group[1].gid])
	}
	return
}
async function remove_fixed_group(g) {
	log && console.log("REMOVING FIXED GROUP",g)
	const hex = Math.abs(g).toString(16);
	const pid= (rheos.processes[hex]?.pid)
	try { 
		pid && process.kill( pid ,'SIGKILL') 
		fixed_groups.delete(g)
		get_all_groups()
	}
	catch { log && console.log("UNABLE TO DELETE PROCESS FOR"),g}	 
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
	if (fg.length){
		my_fixed_groups = JSON.parse(fg)
		Array.isArray (my_fixed_groups)  &&   my_fixed_groups?.forEach(g => {g[1].state = 'paused';fixed_groups.set(g[0],g[1])})			
	}
	my_settings.clear_settings = false	
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
				for (let fg of all_groups){	
					if (! isNaN(settings.values[fg[0]])){
						fg[1].resolution = settings.values[fg[0]]
						fixed_groups.set(fg[0],fg[1])
						await create_fixed_group(fg)
						log && console.log("NOW UNGROUPING ",fg)
						await group_enqueue(fg[1].gid)
					}	else if ((settings.values[fg[0]] == "DELETE"))	{
						remove_fixed_group(fg[0])
						log && console.log("DELETING GROUP",fg[1].name)
						await group_enqueue(fg[1].gid)
					}		
			    }
			my_settings = l.values
			log && console.log(my_settings)
			my_fixed_groups = JSON.stringify([...fixed_groups.entries()])
			roon.save_config("fixed_groups",my_fixed_groups)
			if (my_settings.clear_settings) {
				my_settings.clear_settings = false; my_settings = def.settings} 
				get_all_groups()
				roon.save_config("settings", my_settings)
			}
			await start_heos();
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
	for (const op of outputs) {	
		if (Array.isArray(op?.source_controls)){
			rheos_outputs.set(op.output_id,op)
			const player = await get_player(op?.source_controls[0]?.display_name)
			if  (player){
				player.output = op.output_id
				await update_volume(op,player)
			} else {	
				let group = [...fixed_groups.values()].find(fixed => fixed.output == op.display_name)
			        group = [...rheos_groups.values()].find(r => r?.sum_group == group?.sum_group)
				group?.gid && await update_group_volume(op,group)
				if (op?.volume?.value > my_settings.max_safe_vol || !op.volume.value) { 
					svc_transport.change_volume(op,"absolute",20)		
				}
			}
		} else {
			rheos_outputs.delete(op.output_id)
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
			const group_name = z.outputs.flatMap(output => output.source_controls).flatMap(control => control.display_name)
			const fixed = ([...fixed_groups.values()].find(group => group.display_name === group_name[0]))
			if (fixed?.gid){
				log && console.log("FIXED GROUP FOUND :",fixed)
				const op = z.outputs[0]
				fixed.output = op.display_name
				z.fixed = fixed
				let zone_outputs = fixed.players.map(player => rheos_players.get(player.pid).output)
					zone_outputs.push(op.output_id)
					zone_outputs = zone_outputs.filter(Boolean)
				if ( z.state == "playing"  && !rheos_groups.get(fixed.gid)){
					svc_transport.transfer_zone(z.outputs[0],rheos_outputs.get(zone_outputs[0]))
					svc_transport.group_outputs(zone_outputs)
					play_pending.push(op.output_id)	
					await group_enqueue(fixed.players.map(player => player.pid))	
				    update_status(false,false)			
				} 
			}	
			else {	
				const group = (rheos_groups.get(get_pid(z.outputs[0]?.source_controls[0]?.display_name)))
				group ? log && console.log("VARIABLE GROUP",group.name) :log && console.log("NO VARIABLE GROUP FOUND")
				const old_roon_group = old_zone?.outputs?.map(output => get_pid(output.source_controls[0].display_name))
				const new_roon_group = (z.outputs.map(output => get_pid(output.source_controls[0].display_name)))
				const heos_group = group?.players.map(player => player.pid);
				if ((sum_array(old_roon_group) !== sum_array(new_roon_group))  && (sum_array(new_roon_group) !== sum_array(heos_group))){
					await group_enqueue(new_roon_group)
				}		
			} 
			rheos_zones.set(z.zone_id,z)
			z.state == 'paused' || z.state == 'stopped' || (old_zone?.now_playing?.one_line?.line1 == z?.now_playing?.one_line?.line1 ) ||  console.error(new Date().toLocaleString(), z.display_name, " ▶ ",z?.now_playing?.one_line?.line1)
			resolve()
		} else { 
			const zone =(rheos_zones.get(z))
			log && console.log("DELETING ZONE",zone?.display_name  + "__" + zone?.zone_id|| rheos.zones.get(z).display_name)
			if (zone?.outputs.filter(op => get_pid(op.source_controls[0].display_name)).length >1){
				const lead_player_pid = get_pid(zone.outputs[0]?.source_controls[0]?.display_name)
				const group = (rheos_groups.get(lead_player_pid))
				if (group?.gid) {await group_enqueue(group.players.map(player => player.pid))}
			} 
			rheos_zones.delete(zone?.zone_id || z)	
			resolve()	
		}
	}
	
	}).catch(err => console.error(err))
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
	    group.gid && await heos_command("group", "set_volume", { gid: group.gid, level: op.volume.value }).catch(err => console.error(err))
		group.gid && await heos_command("group", "set_mute", { gid: group.gid, state: op.volume.is_muted ? "on" : "off" }).catch(err => console.error(err))
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
				if ( pid)  {
					if (my_settings[(pid.toString())] == "HR") {
						log  && console.log("SETTING TO HI RES",device.name[0].replace(/\s/g, ""))
						device.enabled = ['1']
						device.mode = ("flc:0,r:192000,s:24").toString().concat(my_settings.flow ? ",flow" : "")
						device.sample_rate = ['192000']
					} 
					else if (my_settings[(pid.toString())] == "THRU") {
						device.enabled = ['1']
						device.mode = "thru"
						device.sample_rate = ['192000']
					}
					else {
						log && console.log("SETTING TO CD",device.name[0].replace(/\s/g, ""))
						device.enabled = ['1']
						device.mode = ("flc:0,r:48000,s:16").toString().concat(my_settings.flow ? ",flow" : "")
						device.sample_rate = ['48000']
					}
					let subtemplate = { "squeeze2upnp": { "common": template.squeeze2upnp.common, "device": [device] } }
					xml_template = builder.buildObject(subtemplate)
					log && console.log("WRITING TO FILE",device.name[0].replace(/\s/g, ""))
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
			resolve()
		})
	})
}
async function start_listening() {
	update_status(false,false)
	await heos_command("system", "prettify_json_response", { enable: "on" }).catch(err => console.error("⚠ Failed to set responses"))
}
async function choose_binary(name, fixed = false) {
	log && console.log("LOADING BINARY for", name ? name  : "SYSTEM", os.platform(),os.arch())
	if (os.platform() == 'linux') {
		try {
		if (os.arch() === 'arm'){
			log && console.error("LOADING armv6 FOR", name)
			await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-armv6hf':'./UPnP/Bin/RHEOS-armv6', 0o555)
			return (fixed ? './UPnP/Bin/squeezelite/squeezelite-armv6hf' :'./UPnP/Bin/RHEOS-armv6')
		} else if (os.arch() === 'arm64'){
			log && console.error("LOADING arm FOR",name)
			await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-arm64':'./UPnP/Bin/RHEOS-arm', 0o555)
			return(fixed ? './UPnP/Bin/squeezelite/squeezelite-armv64':'./UPnP/Bin/RHEOS-arm') 
		} else if (os.arch() === 'x64'){ 
			log && console.error("LOADING x64 FOR",name)
			await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/RHEOS-x86-64', 0o555)
			return(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/RHEOS-x86-64')
		} else if (os.arch() === 'ia32'){
			log && console.error("LOADING ia32 FOR",name)
			await fs.chmod(fixed ?'./UPnP/Bin/squeezelite/squeezelite-i386':'./UPnP/Bin/RHEOS-x86', 0o555)
			return(fixed ? './UPnP/Bin/squeezelite/squeezelite-i386' :'./UPnP/Bin/RHEOS-x86')
		}
		} catch {
			console.error("UNABLE TO LOAD LINUX BINARIES - ABORTING")
			process.exit(0)
		}
	}
	else if (os.platform() == 'win32') {
		log && console.error("LOADING WINDOWS EXE FOR",name)
		return(fixed ? './UPnP/Bin/squeezelite/squeezelite-x64.exe' :'./UPnP/Bin/RHEOS2UPNP.exe')
	} 
	else if (os.platform() == 'darwin') {
		log && console.error("LOADING MAC OS FOR" ,name)
		try {
			await fs.chmod(fixed ? "" :'./UPnP/Bin/RHEOS-macos-x86_64-static', 0o111)
			log && console.error("LOADING MAC BINARIES x86_64")
			return(fixed ? "" :'./UPnP/Bin/RHEOS-macos-x86_64-static')} 
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
	log && console.log("ENQUED",group)
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
			log && console.log("SETTING GROUP",item)
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
		for (let group of fixed_groups){group.state = null}
		const res = await heos_command("group", "get_groups",3000).catch(err => console.error(err))
		if (res?.payload?.length) {
			for (const group of res.payload) {
				group.sum_group = sum_array(group.players.map(player => player.pid))
				rheos_groups.set(group.gid, group)	;
				let fixed = [...fixed_groups.values()].find(fixed => fixed.sum_group == group.sum_group)
				if (fixed?.sum_group){
					fixed.state = "loaded"
				}
			}
			const remove = old_groups.filter(group => !rheos_groups.has(group))
			svc_transport.ungroup_outputs(rheos_zones.get((rheos_players.get(remove[0])?.zone))?.outputs)
		
		} else {
            const remove = old_groups
			svc_transport.ungroup_outputs(rheos_zones.get((rheos_players.get(remove[0])?.zone))?.outputs)
		}
		get_all_groups()
		resolve()
	}).catch(err => console.error(err))
}
async function connect_roon() {
	return new Promise(async function (resolve,reject) {
	const timer = setInterval(() => console.warn(" ⚠ Please ensure RHEOS is enabled in Settings -> Extensions"), 10000)
	const roon = new RoonApi({
		extension_id: "com.RHeos.beta",
		display_name: "Rheos",
		display_version: "0.6.5-6",
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
					    console.error("NETWORK ERROR - RESTARTING ROON SERVICES")
						await start_roon()
						for (const z of data.zones) {
							rheos_zones.set(z.zone_id, z)
						}
						break	
					case "Subscribed" : 
						for (const o of data.outputs) {
							rheos_outputs.set(o.output_id, o)
							if (Array.isArray(o?.source_controls)){
								let player = await get_player(o?.source_controls[0]?.display_name);
								player && (player.output = o.output_id)

							}
						    log && console.log("OUTPUT SUBSCRIBED",o.display_name)
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
					case "Changed" : {	
						if (log){	
							data.zones_seek_changed && data.zones_seek_changed.forEach(zone => console.log(rheos_zones.get(zone.zone_id)?.display_name,zone.seek_position))
							Array.isArray(data.zones_added) && console.log("ZONES ADDED", data.zones_added.map( z=>z.display_name))
							Array.isArray(data.zones_removed) && console.log("ZONES REMOVED", data.zones_removed.map( z=> rheos_zones?.get(z)?.display_name || z))
							Array.isArray(data.zones_changed) && console.log("ZONES CHANGED", data.zones_changed.map( z=>z.display_name))
						}
						Array.isArray(data.zones_added) && await update_zones(data.zones_added);
						Array.isArray(data.zones_changed) && await update_zones(data.zones_changed);
						Array.isArray(data.zones_removed) && await update_zones(data.zones_removed);	
					}	
					break
					default: console.error('⚠',cmd,data)
				}
			})
		},
		core_unpaired: async function (core) {
			core = undefined
		}
	})
	if (roon){
		resolve (roon)
	}else{
		console.error("⚠ NO ROON API FOUND PLEASE CHECK YOUR ROON SERVER IS SWITCHED ON AND ACCESSIBLE AND TRY AGAIN");
		reject
	}
})
}
async function update_status(message = "",warning = false){
	let RheosStatus = rheos_players.size + " HEOS Players on " + system_info[2] +" "+ system_info [3]+" "+ system_info [4] + ' at ' + system_info[0] + '  for ' + get_elapsed_time(start_time) + '\n'
    if (rheos.mode){
		RheosStatus = RheosStatus + "_".repeat(120) + " \n \n " + (rheos.discovery > 0 ? ("⚠      UPnP CONNECTING       " + ("▓".repeat((rheos.discovery < 29 ? rheos.discovery : 30))+"░".repeat(30-(rheos.discovery <29 ? rheos.discovery : 30))))
		: ("DISCOVERED " + rheos_players.size + " HEOS PLAYERS")) + "\n \n"
		for (let player of rheos_players.values()) {
		const { name, ip, model } = player
		let quality = (my_settings[player.name])
		RheosStatus = RheosStatus + (rheos.discovery ? "◐◓◑◒".slice(rheos.discovery % 4, (rheos.discovery % 4) + 1) + " " : (quality === "HR")  ?"◉  " :"◎  " ) + name?.toUpperCase() + " \t " + model + "\t" + ip + "\n"
		}	
	}
	for (let zone of [...rheos_zones.values()].filter(zone => (! zone.display_name.includes("🔗") && zone.state ==="playing") )) {	
		RheosStatus = RheosStatus + "🎶  " + (zone.fixed?.zone?.output || zone.display_name) + "\t ▶ \t" + zone.now_playing?.one_line?.line1 + "\n"
	}
	svc_status.set_status(RheosStatus  )
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

	l.layout.push(
		{ title: "Maximum Safe Volume", type: "integer", setting: 'max_safe_vol', min: 0, max: 100 }
		
	)
	if (players.length) {
		let _players_status = { type: "group", title: "PLAYERS", subtitle: " ", collapsable: true, items: [] }
		players.forEach((player) => {
			if (player) {
				_players_status.items.push({
					title: ('◉ ') + player.name.toUpperCase(),
					type: "dropdown",
					values: [{ title: "Hi-Resolution", value: "HR" }, { title: "CD Quality", value: "CD" },{ title: "Pass Through", value: "THRU" }],
					setting: player.pid.toString()
				})
			}
		})
		l.layout.push(_players_status)
	}
	let _fixed_groups = { type: "group", title: "GROUPS", subtitle: " ", collapsable: true, items: [] };
			for (let group of all_groups.entries()) {
			if (group) {
				let name = group[1].players.map(player=>player.name).toString()
				let values = []
				values.push({title: "HI RES FIXED GROUP", value: 192000})	
				values.push({title: "CD RES FIXED GROUP", value: 48000})	
				values.push({title: "DELETE GROUP", value: "DELETE"})
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
	l.layout.push({
		type: "group", title: "RESET (changes are irreversible, use with caution) ", collapsable: true, items: [
			{ title: "● RESET STATUS TO DEFAULTS", type: "dropdown", setting: 'clear_settings', values: [{ title: "YES", value: true}, { title: "NO", value: false}] },
		]
	})
	return (l)
}
function get_zone_group_value(zone_id){
	let zone = zone_id
	if (typeof(zone_id) !== 'object'){
		zone = rheos_zones.get(zone_id) || rheos_zones.get(zone_id?.zone_id) || false
	}
	if (!zone) {return}
	return( sum_array(zone.outputs.map(o => get_pid(o.source_controls[0].display_name)))) 
}
function get_heos_group_value(group =''){	
	let selected = 0
	if (Array.isArray(group.players)){	
        selected =(sum_array(group?.players.map(player => player.pid)))
	} else if (Array.isArray(group) && typeof group[0] == 'string' && group[0].includes ("+")){
			selected = sum_array((group[0]?.split(' + ').map(player => player?.pid ||  get_pid(player))))
	} else if (Array.isArray(group)){
		selected=(sum_array(group.map(player => rheos_players.get(player)?.pid || get_pid(player))))
    } 
	return(selected)
}
function get_pid(player_name) {
	if (rheos_players.size && typeof player_name === 'string') {
		let player = [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase().replace(/\s/g, "") === player_name?.trim().toLowerCase().replace(/\s/g, ""))
		return player?.pid || 0
	}
}
async function get_player(player_name) {
	let player = [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase().replace(/\s/g, "") === player_name?.trim().toLowerCase().replace(/\s/g, ""))
	return player
}
function sum_array(array) {
	if (array == undefined || !Array.isArray(array)) { return 0 }
	let total = array?.reduce(function (acc, cur) { return acc + cur }, typeof (array[0]) == 'string' ? "" : 0)
	return total
}
function get_all_groups(){
	all_groups.clear()
	for (const group of rheos_groups){
		all_groups.set(get_heos_group_value(group[1]),group[1])
	}
	for (const group of fixed_groups){
		all_groups.set(get_heos_group_value(group[1]),group[1])
	}
	return all_groups
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
        process.kill(Number(process.pid,'SIGKILL'))
		process.exit(0);
    };
    process.on('SIGTERM', handle);
    process.on('SIGINT', handle);
}


