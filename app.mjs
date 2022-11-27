"use-strict"
import HeosApi from "heos-api"
import RoonApi from "node-roon-api"
import RoonApiSettings from "node-roon-api-settings"
import RoonApiStatus from "node-roon-api-status"
import RoonApiVolumeControl from "node-roon-api-volume-control"
import RoonApiSourceControl from "node-roon-api-source-control"
import RoonApiTransport from "node-roon-api-transport"
import child from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import ip from "ip"
import process from "node:process"
import xml2js, { parseStringPromise } from "xml2js"
import util from "node:util"
let roon, svc_status, my_settings, svc_source_control, svc_transport, svc_volume_control, rheos_connection, my_players
const system_info = [ip.address(), os.type(), os.hostname(), os.platform(), os.arch()]
const rheos = { processes: {}, mode: false, discovery: 0, working: false}
const start_time = new Date()
const queue_array = []
const execFileSync = util.promisify(child.execFile);
const spawn = (child.spawn)
const rheos_players = new Map()
const rheos_zones = new Map()
const rheos_groups = new Map()
const builder = new xml2js.Builder({ async: true })
start_heos().catch(err => console.error(err))
start_roon().catch(err => console.error(err))
init_signal_handlers()
async function monitor() {
	setInterval(async () => {
		heos_command("system", "heart_beat", {}).catch(err => console.error("⚠  HEARTBEAT MISSED", err))
		update_status()
	}, 5000)
	return
}
async function add_listeners() {
	process.setMaxListeners(32)
	rheos_connection[1].write("system", "register_for_change_events", { enable: "on" })
		.on({ commandGroup: "system", command: "heart_beat" }, async (res) => {
			res?.heos?.result == "success" || console.error("⚠ HEARTBEAT failed", res)
		})
		.onClose(async (hadError) => {
			console.error("⚠ Listeners closed", hadError)
			await start_up().catch(err => { console.error(err) })
			await discover_devices().catch(err => { console.error(err) })
			await build_devices().catch(err => console.error(err))
			await create_players().catch(err => console.error(err))
			await add_listeners().catch(err => console.error(err))
			await start_listening().catch(err => console.error(err))
		})
		.onError((err) => console.error("⚠ HEOS REPORTS ERROR", err))
		.on({ commandGroup: "event", command: "groups_changed" }, async (res) => {
			await update_heos_groups().catch(err => console.error(err))
			const grouped_zones = [...rheos_zones.values()].filter(zone => (zone.outputs.length > 1))
			for (const zone of grouped_zones) {
				if (![...rheos_groups.keys()].includes(get_pid(zone.outputs[0].source_controls[0].display_name))) {
					svc_transport.ungroup_outputs(zone.outputs.map(output => output?.output_id))
					rheos_zones.delete(zone.zone_id)
				}
			}
			for (const group of rheos_groups.values()) {
				const players =
					group.players.sort(
						(a, b) => {
							let fa = a.role == "leader" ? 0 : 1
							let fb = b.network == "leader" ? 0 : 1
							return fa - fb
						}
					)
				const zone = rheos_zones.get(rheos_players.get(group.gid).zone)
				if (sum_array(zone?.outputs.map(o => get_pid(o.source_controls[0].display_name))) !== sum_array(players.map(player => player.pid))) {
					if (zone?.outputs.length > players.length) {
						svc_transport.ungroup_outputs(zone?.outputs.filter(o => { return !players.map(player => rheos_players.get(player.pid).name.replace(/\s/g, "")).includes(o.source_controls[0].display_name) }).map(o=>o.output_id))
					} else if (zone?.outputs && zone?.outputs?.length < players.length) {
						svc_transport.group_outputs(players.map(player => rheos_players.get(player.pid)?.output || "").filter(o => o))
					}
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
}
async function discover_devices() {
	return new Promise(async function (resolve, reject) {
		const players = ([...rheos_players.values()].map(player => player.name))
		try {
			const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8').catch(new Error("⚠ Config needs to be created"))
			const slim_devices = await parseStringPromise(data)
			if (data && slim_devices.squeeze2upnp.device.map(d => d.friendly_name[0]).toString().length == players.toString().length) {
				resolve(data)
			} else {	
				throw error
			}
		}
		catch {
			let message = setInterval(function () {
				rheos.discovery++;
				update_status()
			}, 1000)
			await create_root_xml()
			const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8').catch(new Error("⚠ Profile needs to be read"))
			rheos.discovery = 0
			clearInterval(message)
			data && resolve(data) || reject()
		}
	})
}
async function create_root_xml() {
	const app = await (choose_binary())
	return new Promise(function (resolve) {	
		execFileSync(app, ['-i', './UPnP/Profiles/config.xml', '-b', ip.address()], () => { resolve() });
	})
}
async function start_heos(counter = 0) {
	counter === 0 && console.log(system_info.toString())
	const heos = [HeosApi.discoverAndConnect({timeout:10000,port:1255, address:ip.address()}),HeosApi.discoverAndConnect({timeout:10000,port:1256, address:ip.address()})]
	try {
		rheos_connection = await Promise.all(heos).catch(()=>{console.error("⚠ Heos Connection failed")})
		rheos_connection[0].socket.setMaxListeners(32)
		rheos_connection[1].socket.setMaxListeners(32)
		my_players = roon.load_config("players") || []
		const players = await get_players().catch(()=>{console.error("⚠ Unable to discover Heos Players")})
		const old_p = sum_array(my_players.map(x => x.pid))
		const new_p = sum_array(players.map(x => x.pid))
		my_players.players = players
		roon.save_config("players",players)	
		if (new_p && (old_p === new_p)){
			for (let player of players) {
				player.resolution = my_settings[player.name]
				rheos_players.set(player.pid, player)
			}
			players.sort((a, b) => {
					let fa = a.network == "wired" ? 0 : 1
					let fb = b.network == "wired" ? 0 : 1
					return fa - fb
			})
			console.table([...rheos_players.values()], ["name", "pid", "model", "ip", "resolution"])
		} else {
		    throw error
		}
		await discover_devices().catch(err => console.error("⚠ Error Discovering Devices",err))
		await build_devices().catch(err => console.error("⚠ Error Building Devices",err))
		await create_players().catch(err => console.error("⚠ Error Creating Players",err))
		await add_listeners().catch(err => console.error("⚠ Error Adding Listeners",err))
		await start_listening().catch(err => console.error("⚠ Error Starting Listening",err))	
	}
	catch (err) {
		counter === 0 && console.log("⚠ SEARCHING FOR NEW HEOS PLAYERS")
		setTimeout(() => {start_heos(++counter)}, 5000)
	}
}
async function get_players() {
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
async function create_players() {
	for await (const player of rheos_players.values()) {
		if (!rheos.processes[player.pid] || rheos.processes[player.pid].killed) {
			const name = player.name.replace(/\s/g, "")
			await (fs.truncate('./UPnP/Profiles/' + name + '.log', 0).catch(() => { "Failed to clear log for " + player.name}))
			const app = await (choose_binary()).catch(err => console.log("Failed to find binary",err))
			rheos.processes[player.pid] = spawn(app, ['-b', ip.address(), '-Z', '-M', name,
				'-x', './UPnP/Profiles/' + name + '.xml', 
				'-p','./UPnP/Profiles/' + name + '.pid',
				'-f', './UPnP/Profiles/' + name + '.log'],
					{ stdio: 'ignore' })
		}
	}
}
async function start_roon() {
	roon = await connect_roon().catch((err)=> {console.log("Failed to connect with ROON server",err)})
	svc_status = new RoonApiStatus(roon)
	svc_source_control = new RoonApiSourceControl(roon)
	svc_volume_control = new RoonApiVolumeControl(roon)
	svc_transport = new RoonApiTransport(roon)
	my_settings = roon.load_config("settings") || {}
	my_players = roon.load_config("players") || []
	my_settings.host_ip || (my_settings.host_ip = ip.address())
	my_settings.streambuf_size || (my_settings.streambuf_size = 524288)
	my_settings.output_size || (my_settings.output_size = 8388608)
	my_settings.stream_length || (my_settings.stream_length = -3)
	my_settings.seek_after_pause || (my_settings.seek_after_pause = 1)
	my_settings.volume_on_play || (my_settings.volume_on_play = -1)
	my_settings.volume_feedback || (my_settings.volume_feedback = 0)
	my_settings.accept_nexturi || (my_settings.accept_nexturi = 0)
	my_settings.flac_header || (my_settings.flac_header = 2)
	my_settings.keep_alive || (my_settings.keep_alive = 0)
	my_settings.next_delay || (my_settings.next_delay = 15)
	my_settings.flow || (my_settings.flow = false)
	my_settings.send_coverart || (my_settings.send_coverart = 0)
	my_settings.send_metadata || (my_settings.send_metadata = 0)
	const svc_settings = new RoonApiSettings(roon, {
		get_settings: async function (cb) {
			rheos.mode = true
			await update_status().catch(()=>{console.error("Failed to update state")})
			await create_players().catch(()=>{console.error("Failed to create players")})
			cb(makelayout(my_settings))
		},
		save_settings: async function (req, isdryrun, settings) {
			rheos.mode = false
			create_players()
			let l = makelayout(settings.values)
			if (l.values.default_player_ip && !l.has_error) {
				await HeosApi.connect(l.values.default_player_ip, 1000).catch(err => (l.has_error = err))
			}
			req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l })
			if (!isdryrun && !l.has_error) {
				rheos.mode = false
				update_status()
				my_settings = l.values
				svc_settings.update_settings(l)
				roon.save_config("settings", my_settings)
				await build_devices().catch(()=>{console.error("Failed to build devices")})
			}
		}
	})
	roon.init_services({
		required_services: [RoonApiTransport], provided_services: [svc_status, svc_source_control, svc_volume_control, svc_settings]
	})
	roon.start_discovery()
	return (roon)
}
async function update_outputs(outputs){
	return new Promise(async function (resolve) {
    let player
	for (const op of outputs) {	
		if (op.source_controls && (player = get_player(op?.source_controls[0]?.display_name))){
			player.output = op.output_id
			update_volume(op,get_player(op?.source_controls[0]?.display_name))	
		}
	}
	resolve()
	}).catch(err => console.error(err))
}
async function update_zones(zones){
	return new Promise(async function (resolve) {
	for (const z of zones) {
		if (z.outputs ){
			const old_zone =  rheos_zones.get(z.zone_id)
			const lead_player_pid = get_pid(z.outputs[0]?.source_controls[0]?.display_name)
			if (lead_player_pid) {rheos_players.get(lead_player_pid).zone = z.zone_id}
			const group = (rheos_groups.get(lead_player_pid))
			const old_roon_group = (rheos_zones.get(z.zone_id))?.outputs.map(output => get_pid(output.source_controls[0].display_name))
			const new_roon_group = (z.outputs.map(output => get_pid(output.source_controls[0].display_name)))
			const heos_group = group?.players ? group?.players.map(player => player.pid) : group;
			z.state == 'paused' || z.state == 'stopped' || (old_zone?.now_playing?.one_line?.line1 == z?.now_playing?.one_line?.line1 ) ||  console.error(new Date().toLocaleString(), z.display_name, " ▶ ",z?.now_playing?.one_line?.line1)	
			if ((sum_array(old_roon_group) !== sum_array(new_roon_group))  && (sum_array(new_roon_group) !== sum_array(heos_group))) {
				await group_enqueue(new_roon_group)
			}
			rheos_zones.set(z.zone_id, z)
		} else{  
			let zone =(rheos_zones.get(z))
			zone?.state && (zone.state = 'indeterminate')
		}
	}
	resolve()
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
					}
				],
				"device": []
			}
		}
		let data = await (fs.readFile('./UPnP/Profiles/config.xml', 'utf8'))
		xml2js.parseString(data, async (err, result) => {
			if (err) { throw err }
			if (!result?.squeeze2upnp?.device?.entries()) {return}
			for await (const [index, device] of result?.squeeze2upnp?.device?.entries()) {
				const pid = get_pid(device.name[0])
				if (pid) {
					if (my_settings[(device.name[0])] == "HR") {
						device.enabled = ['1']
						device.mode = (("flc:0,r:-192000,s:24").toString().concat(my_settings.flow ? ",flow" : ""))
						device.sample_rate = ['192000']
					} else {
						device.enabled = ['1']
						device.mode = (("flc:0,r:-48000,s:16").toString().concat(my_settings.flow ? ",flow" : ""))
						device.sample_rate = ['48000']
					}
					let subtemplate = { "squeeze2upnp": { "common": template.squeeze2upnp.common, "device": [device] } }
					xml_template = builder.buildObject(subtemplate)
					await fs.writeFile("./UPnP/Profiles/" + (device.name[0].replace(/\s/g, "")) + ".xml", xml_template).catch(()=>{console.error("⚠ Failed to create template fo "+device.name[0])})
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
			resolve()
		})
	})
}
async function start_listening() {
	update_status()
	await heos_command("system", "prettify_json_response", { enable: "on" }).catch(err => console.error("⚠ Failed to set responses"))
}
async function choose_binary() {
	if (os.platform() == 'linux') {
		if (os.arch() === 'arm'){
			return ('./UPnP/Bin/RHEOS-arm')
		} else if (os.arch() === 'arm64'){
			return('./UPnP/Bin/RHEOS-arm')
		} else if (os.arch() === 'x64'){ 
			return('./UPnP/Bin/RHEOS-x86-64')
		} else if (os.arch() === 'ia32'){
			return('./UPnP/Bin/RHEOS-x86')
		}
	}
	else if (os.platform() == 'win32') {
		return('./UPnP/Bin/RHEOS-upnp.exe')
	} 
	else {
		console.error("THIS OPERATING SYSTEM IS IS NOT SUPPORTED");
	 	process.exit()
	}
}
async function group_enqueue(group) {
	return new Promise(async (resolve, reject) => {
		if (queue_array.length){
        	for (let queued_group of queue_array){
 				let checkSubset = (group,queued_group) => {
					return group.every((player) => {
						return queued_group.includes(player)
					})
				}
				if (checkSubset){
					(group.length > queued_group.length) || (queued_group = group)
				} else {
					queue_array.push({ group, resolve, reject })
				}
			}
		} else {
			queue_array.push({ group, resolve, reject })
		}
		group_dequeue().catch((err)=>{console.log("Deque error",err)})
	})
}	
async function group_dequeue(timer = 30000) {
	if (rheos.working) { return }
	const item = queue_array[0]
	if (!item?.group ) {
		return
	}
	try {
		rheos.working = true
		if (sum_array(rheos_groups.get(item.group[0])?.players?.map(player => player.pid) ||  []) !== sum_array(item.group)) {
			if (item.group.length == 1) { item.group = item.group[0] }
			await heos_command("group", "set_group", { pid: item?.group?.toString() },timer).catch((err) => {item.reject(err); rheos.working = false; group_dequeue() })
		}
		rheos.working = false 
		queue_array.shift()
		item.resolve()
		await group_dequeue().catch(err => console.error("Failed to deque group",err))
	}
	catch (err) {
		rheos.working = false
		queue_array.shift()
		item.reject(err)
		await group_dequeue().catch(err => console.error("Failed to deque group",err))
	}
}
async function update_heos_groups() {
	return new Promise(async function (resolve) {
		rheos_groups.clear()
		const res = await heos_command("group", "get_groups",30000).catch(err => console.error(err))
		if (res?.payload.length) {
			for (const group of res.payload) {
				rheos_groups.set(group.gid, group)	
			}
		}
		resolve(res)
	}).catch(err => console.error(err))
}
async function connect_roon() {
	return new Promise(async function (resolve,reject) {
	const timer = setInterval(() => console.warn(" ⚠ Please ensure RHEOS is enabled in Settings -> Extensions"), 10000)
	const roon = new RoonApi({
		extension_id: "com.RHeos.beta",
		display_name: "Rheos",
		display_version: "0.4.1-2",
		publisher: "RHEOS",
		email: "rheos.control@gmail.com",
		website: "https:/github.com/LINVALE/RHEOS",
		log_level: "none",
		core_paired: async function (core) {
			clearInterval(timer)
			await monitor()
			svc_transport = core.services.RoonApiTransport
			svc_transport.subscribe_outputs(async function (cmd, data) {
				switch (cmd){
					case "Network Error" : 	
						start_roon()
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
						}
						break
					case "Changed" : {
						
						Array.isArray(data.zones_added) && await update_zones(data.zones_added,"ADDED");
						Array.isArray(data.zones_changed) && await update_zones(data.zones_changed,"CHANGED");
						Array.isArray(data.zones_removed) && await update_zones(data.zones_removed,"REMOVED");
					}	
				}
			})
		},
		core_unpaired: async function (core) {
			core = undefined
		}
	})
	resolve (roon)
	})
}
async function update_status() {
	let RheosStatus = '\n' + "RHEOS BRIDGE RUNNING : On " + system_info[2] + ' at ' + system_info[0] + '  for ' + get_elapsed_time(start_time) + '\n'
	RheosStatus = RheosStatus + "_".repeat(120) + " \n \n " + (rheos.discovery > 0 ? ("⚠ UPnP CONNECTING  " + ("▓".repeat(rheos.discovery)+"░".repeat(40-rheos.discovery)))
		: ("DISCOVERED " + rheos_players.size + " HEOS PLAYERS")) + "\n \n"
	for (let player of rheos_players.values()) {
		const { name, ip, model } = player
		let quality = (my_settings[player.name])
		RheosStatus = RheosStatus + (rheos.discovery ? "◐◓◑◒".slice(rheos.discovery % 4, (rheos.discovery % 4) + 1) + " " : (quality === "HR")  ?"◉  " :"◎  " ) + name?.toUpperCase() + " \t " + model + "\t" + ip + "\n"
	}
	RheosStatus = RheosStatus + "_".repeat(120) + "\n \n"
	for (let zone of [...rheos_zones.values()].filter(zone => zone.state == "playing")) {
		RheosStatus = RheosStatus + "🎶  " + zone.display_name + "\t ▶ \t" + zone.now_playing.one_line.line1 + "\n"
	}
	RheosStatus = RheosStatus + "_".repeat(120)
	svc_status.set_status(RheosStatus, rheos.mode)
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
		let _players_status = { type: "group", title: "PLAYER STATUS", subtitle: " ", collapsable: false, items: [] }
		players.forEach((player) => {
			if (player) {
				_players_status.items.push({
					title: ('◉ ') + player.name.toUpperCase(),
					type: "dropdown",
					values: [{ title: "Hi-Resolution", value: "HR" }, { title: "CD Quality", value: "CD" }],
					setting: player.name
				})
			}
		})
		l.layout.push(_players_status)
	}
	l.layout.push({
		type: "group", title: "ADVANCED SETTINGS (experimantal) ", collapsable: false, items: [
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
			{ title: "● Gapless", type: "dropdown", setting: 'flow', values: [{ title: "On", value: true }, { title: 'Off', value: false }] },
			{ title: "● Send Metadata", type: "dropdown", setting: 'send_metadata', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
			{ title: "● Send Cover Art", type: "dropdown", setting: 'send_coverart', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] }
		]
	})
	return (l)
}
function get_pid(player_name) {
	if (rheos_players.size) {
		let player = [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase().replace(/\s/g, "") === player_name?.trim().toLowerCase().replace(/\s/g, ""))
		return player?.pid
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
	return (days ? days + (days == 1 ? " day " : " days " ) : "") + (hours ? hours + 'hour'+ (hours === 1 ? "  " : "s " ) : "") + minutes + (minutes === 1 ? " minute ":" minutes ") + seconds +(seconds === 1 ? " second " : " seconds ");
}
function init_signal_handlers() {
    const handle = function(signal) {
		console.log("RHEOS IS SHUTTING DOWN")
		for (let player of rheos_players.values()) {
			if (rheos.processes[player.pid] && !rheos.processes[player.pid].killed) { 
				try {process.kill(Number(rheos.processes[player.pid].pid))}
				catch {}
			}
		}
        process.exit(0);
    };
    process.on('SIGTERM', handle);
    process.on('SIGINT', handle);
}


