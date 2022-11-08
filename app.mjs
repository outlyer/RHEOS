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
import util, { isArray } from "node:util"
let roon, svc_status, my_settings, svc_source_control, svc_transport, svc_volume_control, rheos_connection, my_players
const system_info = [ip.address(), os.type(), os.hostname(), os.platform(), os.arch()]
console.log(system_info.toString())
const rheos = { processes: {}, mode: false, discovery: 0, working: false}
const start_time = new Date()
const queue_array = []
const execFileSync = util.promisify(child.execFile);
const spawn = (child.spawn)
const rheos_players = new Map()
const rheos_zones = new Map()
const rheos_groups = new Map()
const builder = new xml2js.Builder({ async: true })
clean_up()
await start_roon().catch(err => console.error(err))
await start_up().catch(err => console.error(err))
await discover_devices().catch(err => console.error(err))
await build_devices().catch(err => console.error(err))
await create_players().catch(err => console.error(err))
await add_listeners().catch(err => console.error(err))
await start_listening().catch(err => console.error(err))
await update_heos_groups().catch(err => console.error(err))

async function monitor() {
	setInterval(async () => {
		heos_command("system", "heart_beat", {}).catch(err => console.error("HEARTBEAT MISSED", err))
		update_status()
	}, 5000)
	return
}
async function add_listeners() {
	if (!rheos_connection) {return}
	rheos_connection[1].write("system", "register_for_change_events", { enable: "on" })
		.on({ commandGroup: "system", command: "heart_beat" }, async (res) => {
			res?.heos?.result == "success" || console.error("HEARTBEAT failed", res)
		})
		.onClose(async (hadError) => {
			console.error("Listeners closed", hadError)
			await start_up().catch(err => { console.error(err) })
			await discover_devices().catch(err => { console.error(err) })
			await build_devices().catch(err => console.error(err))
			await create_players().catch(err => console.error(err))
			await add_listeners().catch(err => console.error(err))
			await start_listening().catch(err => console.error(err))
		})
		.onError((err) => console.error("HEOS REPORTS ERROR", err))
		.on({ commandGroup: "event", command: "groups_changed" }, async (res) => {
			roon.logging && console.warn("Player Groups have changed")
			await update_heos_groups().catch(err => console.error(err))
			const grouped_zones = [...rheos_zones.values()].filter(zone => (get_pid(zone.outputs[0].display_name) && zone.outputs.length > 1))
			roon.logging && console.warn([...rheos_groups.values()].map(x => x.name),grouped_zones.map(group => group.display_name))
			if (rheos_groups.size < grouped_zones.length) {
				for (const zone of grouped_zones) {
					if (![...rheos_groups.keys()].includes(get_pid(zone.outputs[0].display_name))) {
						svc_transport.ungroup_outputs(zone.outputs.map(output => output?.output_id))
					}
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
				if (sum_array(zone?.outputs.map(o => get_pid(o.display_name))) !== sum_array(players.map(player => player.pid))) {
					if (zone?.outputs.length > players.length) {
						const ungroup = zone?.outputs.filter(o => { return !players.map(player => player.name).includes(o.display_name) })
						svc_transport.ungroup_outputs(ungroup)
					} else if (zone?.outputs?.length < players.length) {
						let group = players.map(player => rheos_players.get(player.pid)?.output)
						svc_transport.group_outputs(group)
					}
				}
			}
		})
		.on({ commandGroup: "event", command: "players_changed" }, async () => {
			roon.logging && console.warn("Players Changed")
			const players = await heos_command("player", "get_players").catch(err => console.error("PLAYERS", err))
			const player_names = players.payload.map(player => player.name)
			const new_players = players.payload.filter(player => !player.output)
			const deleted_players = [...rheos_players.values()].filter(player => !player_names.includes(player.name))
			for (let player of new_players) {
				roon.logging && console.warn("New Player",player.name)
				my_settings[player.name] = "Off"
			}
			for (let player of deleted_players) {
				roon.logging && console.warn("Removed Player",player.name)
				rheos_players.delete(player.pid)
				delete my_settings[player.name]
			}
		})
		.on({ commandGroup: "event", command: "player_playback_error" }, async (res) => {
			console.error("PLAYBACK ERROR", res.heos.message.parsed.error)
			if ( res.heos.message.parsed.error.includes("unable to play media")){
				console.error(res)
				svc_transport.control(player.zone, 'play')
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
			const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8').catch(new Error("file needs to be created"))
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
			await create_root_xml().catch(console.warn("CREATING NEW UPnP CONNECTIONS for HEOS PLAYERS"))
			const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8').catch(new Error("file needs to be created"))
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
async function start_up(counter = 0) {
	const heos = [HeosApi.discoverAndConnect({timeout:10000,port:1255, address:ip.address()}),HeosApi.discoverAndConnect({timeout:10000,port:1256, address:ip.address()})]
	try {
		rheos_connection = await Promise.all(heos).catch(()=>{console.error("Heos Connection failed")})
		rheos_connection[0].socket.setMaxListeners(0)
		let players = await get_players()
		let old_p = sum_array(my_players.map(x => x.pid))
		let new_p = sum_array(players.map(x => x.pid))
		my_players.players = players
		roon.save_config("players",players)	
		if (new_p && (old_p === new_p)){
		for (let player of players) {
			player.resolution = my_settings[player.name]
			rheos_players.set(player.pid, player)
		}
		players
			.sort((a, b) => {
				let fa = a.network == "wired" ? 0 : 1
				let fb = b.network == "wired" ? 0 : 1
				return fa - fb
			})
		console.table([...rheos_players.values()], ["name", "pid", "model", "ip", "resolution"])
		} else {
			console.error("ERROR IN STARTUP")
		    throw error
		}
	}
	catch (err) {
		console.log("SEARCHING FOR HEOS PLAYERS")
		setTimeout(() => {start_up(++counter)}, 5000)
	}
}
async function get_players() {
	if (!rheos_connection) {reject("AWAITING CONNECTION")}
	return new Promise(function (resolve, reject) {
		rheos_connection[0].write("player", "get_players", {})
			.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
				if (players?.payload?.length) {
					resolve(players?.payload)
				} else if (players.heos.result == "fail") {
					reject(players)
				} else if (players.heos.message.unparsed == "command under process") {
					console.log("SEARCHING FOR HEOS PLAYERS")
					rheos_connection[0].once({ commandGroup: 'player', command: 'get_players' },
						(res) => {
							resolve(res.payload)
						})
				} else {
					reject(players)
				}
			})
	})
}
async function create_players() {
	for await (const player of rheos_players.values()) {
			if (!rheos.processes[player.pid] || rheos.processes[player.pid].killed) {
				await (fs.truncate('./UPnP/Profiles/' + player.name.replace(/\s/g, "") + '.log', 0).catch(() => { }))
				const app = await (choose_binary())
				rheos.processes[player.pid] = spawn(app, ['-b', ip.address(), '-Z', '-M', player.name,
					'-x', './UPnP/Profiles/' + player.name.replace(/\s/g, "") + '.xml', 
					'-p','./UPnP/Profiles/' + player.name.replace(/\s/g, "") + '.pid',
					'-f', './UPnP/Profiles/' + player.name.replace(/\s/g, "") + '.log'],
					 { stdio: 'ignore' })
			}
	}
}
async function start_roon() {
	roon = connect_roon()
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
			await update_status()
			await create_players()
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
				await build_devices()
			}
		}
	})
	roon.init_services({
		required_services: [RoonApiTransport], provided_services: [svc_status, svc_source_control, svc_volume_control, svc_settings]
	})
	roon.logging = false
	roon.start_discovery()
	return (roon)
}
function connect_roon() {
	let timer = setInterval(() => console.warn(" ⚠ Please ensure RHEOS is enabled in Settings -> Extensions"), 10000)
	const roon = new RoonApi({
		extension_id: "com.RHeos.beta",
		display_name: "RHeos",
		display_version: "0.3.4-0",
		publisher: "RHEOS",
		email: "rheos.control@gmail.com",
		website: "https:/github.com/LINVALE/RHEOS",
		log_level: "none",
		core_paired: async function (core) {
			clearInterval(timer)
			await monitor()
			svc_transport = core.services.RoonApiTransport
			svc_transport.subscribe_outputs(async function (cmd, data) {
				if (cmd == "Subscribed") {
					data.outputs?.forEach((op) => {
						if (op.source_controls){
							const player = [...rheos_players.values()].find(x => x.name === op?.source_controls[0]?.display_name)
							if (player) {
								player.output = op
								player.volume = { level: op?.volume?.value, mute: op?.volume?.is_muted ? "on" : "off" }
								player.zone = op.zone_id
							}
						}
					})
				}
				if (cmd == "Changed" && data.outputs_changed) {
					for await (let op of data.outputs_changed) {
						if (op.source_controls){
							let player = get_player(op?.source_controls[0]?.display_name)
							if (player?.name && op?.volume) {
								if ((player.volume?.mute !== (op?.volume?.is_muted ? "on" : "off")) && op?.volume?.is_muted !== player?.output?.volume?.is_muted) {
									player.volume = { level: op?.volume?.value, mute: op?.volume?.is_muted ? "on" : "off" }
										await heos_command("player", "set_mute", { pid: player.pid, state: op?.volume?.is_muted ? "on" : "off" }).catch(err => console.error(err))// :
								}
								else if (player.volume?.level !== op.volume.value && op.volume.value !== player?.output?.volume?.value) {
									player.volume = { level: op.volume.value, mute: op?.volume?.is_muted ? "on" : "off" }
										await heos_command("player", "set_volume", { pid: player.pid, level: op.volume.value }).catch(err => console.error(err))// :
								}
							}
							if (player) {
								player.output = op
								player.zone = op.zone_id
							}
						}	
					}
				}
				if (cmd == "Changed" && data.outputs_added) {
					for await (let op of data.outputs_added) {
						if (op.source_controls){
						const player = [...rheos_players.values()].find(player => player.name == op?.source_controls[0]?.display_name)
							if (player) {
								player.output = op
								player.zone = op.zone_id
								if (player?.name && op?.volume) {
										player.volume = { level: op?.volume?.value, mute: op?.volume?.is_muted ? "on" : "off" }
											await heos_command("player", "set_mute", { pid: player.pid, state: op?.volume?.is_muted ? "on" : "off" }).catch(err => console.error(err))
											await heos_command("player", "set_volume", { pid: player.pid, level: op.volume.value }).catch(err => console.error(err))
								}
							}
						}
						
					}
				}
				if (cmd == "Changed" && data.outputs_removed) {
					data.outputs_removed?.forEach((op) => {
						if (op.source_controls){
							const player = get_player(op.source_controls[0].display_name)
							if (player) {
								player.output = undefined
								player.zone = undefined
							}
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
						for (const e of data.zones) {
							rheos_zones.set(e.zone_id, e)
						}
					}
					return roon
				}
				if (cmd === "Changed") {
					if (data.zones_removed) {
						for (const e of data.zones_removed) {
							await update_heos_groups()
							const zone = rheos_zones.get(e)
							const group = rheos_groups.get(get_pid(zone?.outputs[0].source_controls[0]?.display_name))
							if (zone?.outputs.length > 1 && group) {
								group_enqueue([get_pid(zone?.outputs[0].source_controls[0]?.display_name)])
								rheos_groups.delete(get_pid(zone?.outputs[0].source_controls[0]?.display_name))
							}
							rheos_zones.delete(e)
						}
					}
					if (data.zones_added) {
						for (const e of data.zones_added) {
							await update_heos_groups()
							const group = (rheos_groups.get(get_pid(e.outputs[0].source_controls[0]?.display_name)))
							const roon_group = (e.outputs.map(output => get_pid(output.source_controls[0]?.display_name)))
							const heos_group = group?.players ? group?.players.map(player => player.pid) : group
							if (roon_group.length > 1 && (sum_array(roon_group) !== sum_array(heos_group))) {
								group_enqueue(roon_group)
							}
							rheos_zones.set(e.zone_id, e)
						}
					}
					if (data.zones_changed) {
						for (const e of data.zones_changed) {
							await update_heos_groups()
							const zone = rheos_zones.get(e.zone_id)
							const group = (rheos_groups.get(get_pid(e.outputs[0].source_controls[0]?.display_name)))
							const roon_group = (e.outputs.map(output => get_pid(output.source_controls[0]?.display_name)))
							const heos_group = group?.players ? group?.players.map(player => player.pid) : group;
							( (e.state == 'paused' || e.state == 'stopped') ||  (play_state_changed(zone.state,e.state) && zone.now_playing.one_line.line1 === e.now_playing.one_line.line1)) || console.error(new Date().toLocaleString(), e.display_name, " ▶ ",e.now_playing?.one_line.line1)	
							if (roon_group.length > 1 && (sum_array(roon_group) !== sum_array(heos_group))) {
								group_enqueue(roon_group)
							}
							rheos_zones.set(e.zone_id, e)
						}
					}
				}
			})
		},
		core_unpaired: function (core) {
			core = undefined
		}
	})
	return (roon)
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
					await fs.writeFile("./UPnP/Profiles/" + (device.name[0].replace(/\s/g, "")) + ".xml", xml_template)
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
			await fs.writeFile("./UPnP/Profiles/config.xml", xml_template)
			resolve()
		})
	})
}
async function start_listening() {
	update_status()
	await heos_command("system", "prettify_json_response", { enable: "on" }).catch(err => console.error("ERR 5", err))
}
function update_status() {
	let RheosStatus = '\n' + "RHEOS BRIDGE RUNNING : On " + system_info[2] + ' at ' + system_info[0] + '  for ' + get_elapsed_time(start_time) + '\n'
	RheosStatus = RheosStatus + "_".repeat(120) + " \n \n " + (rheos.discovery > 0 ? ("CONNECTING HEOS DEVICES TO UPNP" + (".".repeat(rheos.discovery)))
		: ("DISCOVERED " + rheos_players.size + " HEOS PLAYERS")) + "\n \n"
	for (let player of rheos_players.values()) {
		const { name, ip, model } = player
		let quality = (my_settings[player.name])
		RheosStatus = RheosStatus + (rheos.discovery ? "◐◓◑◒".slice(rheos.discovery % 4, (rheos.discovery % 4) + 1) + " " : (quality && quality == "CD") ? "◎  " : "◉ ") + name?.toUpperCase() + " \t " + model + "\t" + ip + "\n"
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
	if (array == undefined || !isArray(array)) { return 0 }
	let total = array?.reduce(function (acc, cur) { return acc + cur }, typeof (array[0]) == 'string' ? "" : 0)
	return total
}
async function choose_binary() {
	if (os.platform() == 'linux') {
		if (os.arch() === 'arm'){
			await fs.chmod('./UPnP/Bin/RHEOS-armv5te',0o700)
			return ('./UPnP/Bin/RHEOS-armv5te')
		} else if (os.arch() === 'arm64'){
			await fs.chmod('./UPnP/Bin/RHEOS-aarch64',0o700)
			return('./UPnP/Bin/RHEOS-aarch64')
		} else if (os.arch() === 'x64'){ 
			await fs.chmod('./UPnP/Bin/RHEOS-x86-64',0o700)
			return('./UPnP/Bin/RHEOS-x86-64')
		} else if (os.arch() === 'ia32'){
			await fs.chmod('./UPnP/Bin/RHEOS-x86',0o700)
			return('./UPnP/Bin/RHEOS-x86')
		}
	}
	else if (os.platform() == 'win32') {
		return('./UPnP/Bin/RHEOS-upnp.exe')
	} 
}
		
async function group_enqueue(group) {
	return new Promise(async (resolve, reject) => {
		if (queue_array.find(awaited => sum_array(awaited.group) === sum_array(group))) {
			resolve()
		}
		queue_array.push({ group, resolve, reject })
		await group_dequeue()
	})
}
async function group_dequeue(timer = 30000) {
	if (rheos.working) { return }
	const item = queue_array.shift()
	if (!item) {
		return
	}
	try {
		rheos.working = true
		let new_group = item.group[0] || item.group
		let group = rheos_groups.get(new_group)
		group = group?.players?.length ? group.players?.map(player => player.pid) : []
		if (sum_array(group) !== sum_array(item.group)) {
			if (item.group.length == 1) { item.group = item.group[0] }
			await heos_command("group", "set_group", { pid: item.group.toString() },timer).catch((err) => {item.reject(err); rheos.working = false; group_dequeue() })
			rheos.working = false
		}
		item.resolve()
		group_dequeue().catch(err => console.log(err))
	}
	catch (err) {
		rheos.working = false
		item.reject(err)
		queue_array.shift()
		group_dequeue().catch(err => console.error(err))
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
	return (days ? days + (days == 1 ? " day " : "days " ) : "") + (hours ? hours + (hours == 1 ? " hr " : "hrs " ) : "") + minutes + (minutes>1 ? " minutes ":" minute ") + seconds +(seconds >1 ? " seconds" : " second");
}
function play_state_changed(old_state,new_state){
	const test = ['stopped','paused'];
	return (test.indexOf(old_state)<0)===(test.indexOf(new_state)<0)
}
function clean_up(){	
	process.on('SIGINT',() => {
		console.log("SHUTTING DOWN")
		if (rheos.processes.main && !rheos.processes.main.killed) {
			process.kill(rheos.processes.main.pid)
		}
		for (let player of rheos_players.values()) {
			if (rheos.processes[player.pid] && !rheos.processes[player.pid].killed) { 
				process.kill(Number(rheos.processes[player.pid].pid))
			}
		}
		process.exit()
	})
}
/** "UNTESTED STATIC FILES - to be implented";  squeeze2upnp-armv6hf-static;squeeze2upnp-ppc-static;squeeze2upnp-sparc-static;*/
