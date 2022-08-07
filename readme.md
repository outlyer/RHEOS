# RHEOS


A ROON Extension to allow  control of Denon/Marantz HEOS devices from ROON.

## Features

-   🔎 Automatic discovery of HEOS devices and make them available as ROON audio devices (via UPnP).
-   🎯 Bi-directional Control of player play, pause, previous, volume, mute and grouping within HEOS players from ROON or Heos App.
-   🎶 Group HEOS devices from ROON. Uses HEOS grouping to ensure synchronization with other HEOS players. Only groups HEOS players.
-   🔊 Does not use AirPlay so can stream at Hi-Resolution for HS2 players.
-   🚫 Written in pure Javascript / Nodejs with limited module dependencies (heos-api, squeeze2UPnP, Xml2js,ip)


## Installation

Install/Update nodejs for your system (tested on Windows and Raspberry pi 4) . This requires at least Node v16, the current stable version. [https://nodejs.org/en/download/]

Clone a local copy of this repository to a local directory './RHEOS', or copy the zip file and unpack into './RHEOS'.

From the command line try : “gh repo clone LINVALE/RHEOS ./RHEOS”

(If successful you will see a ‘package.json’ and ‘package-lock.json’ as well as ‘app.mjs’ in the directory, along with other required files)

Then switch to that directory and type “npm install”, This should create a folder ‘node_modules’ with the required dependencies.


To install rheos using `npm`: 

```
npm install rheos
```

## Initial Set Up

Run the app from the directory to which you downloaded on the command line type  -> "node ."

Enable Squeezebox Support via Setup -> Enable squeezebox support

Enable RHEOS in ROON via Settings -> Extensions -> enable


### Connecting to devices

RHEOS will attempt to discover all connected HEOS devices on start up. Tested to date with Marantz HEOS enabled AVRs, PLAYERS :HEOS DRIVE HS1 and HS2, HEOS1, HEOS3, HEOS 5 and HEOS 7, HEOS LINK and HEOS AMP. Maximum number of players that can be simulatnaeosly grouped is 16, dependent upon network performance.

Players will appear as Squuezebox Devices in ROON Settings -> Audio. Intially all unnamed. Each device needs to be named in ROON with the same name used in HEOS (Edit Rooms -> Select / Edit Name). On first set up the ROON device setup -> audio device will be shown as "RHEOS". In order to identify which ROON output is linked (if you have more than one) select Settings -> Extensions and the setup screen will appear shwing the discovered HEOS players. Exit this screen WITHOUT saving and go back to Settings -> Audio. You will now be in "configuration" mode and audio devices will be identified by the names of the discovered HEOS players. Each Audio device MUST be named exactly to match the Room name in HEOS (now shown in the Device set up with a reminder to save Extension Settings when you are finished naming all players). Some HEOS dvices add identifiers to the name you edit in the HEOS app, dependent on model. Ensure you use the entire name as shown. This only needs to be done once (unless you reset or transfer your ROON core).  **Edit each RHEOS Audio Device name.** I also strongly recommend that you select a Resync delay of 500 ms aor more. This will minimize problems when a play list switched between songs with different resolutons casusing upredictable playback. Choose exactly the same resync delay for each and all the RHEOS players. This is also a good time to select FLAC compression in advanced - the RHEOS bridge uses FLAC conversion and compression is helpful in reducing network load.

Then return to Extensions -> settings and SAVE. This should now return to "play" mode. Any time you enter Extension settings play mode is suspended and devices can be configured.

If you have HS2 devices you may wish to enable Hi-Res streaming (192 kHz 24 Bit Flac). Do this in Settings-> Extension -> RHEOS -> Settings for each HS2 player. This may increase network load and success will depend upon wired connections and a fast ethernet. All players default to CD quality 48kHz 24 bit.

The only other settings are an IP address of the Heos Player you would like to use as the main connection. All HEOS commands are sent tho this and RHEOS listens for changes to any of your players through this. If there is a problem discovering your HEOS players you can try to edit this. Once a connection has been made, all HEOS player IPs are stored and can be selected from the drop-down. If none has been found you may enter the IP address, if you can find this from your router DHCP table.

Roon Extension Host IP Address shows the discovered IP address of the device you are using to run RHEOS - a windows machine or 32 bit rasberry pi at present. You may want to try editing this if for some reason network discovery is not working.

Under RHEOS UPnP Settings there are options to select buffer-size, output-size, stream-length, seek-after-pause, volume-on-play, volume-feedback, FLAC-header, keep-alive, next-delay, send-meta-data and send-cover-art. The defaulst are te settings I have found to work best across a variety of HEOS players so I recoomend not adjusting these unless you have specific needs or something isnt working for you. Full information on them can be found here https://github.com/philippe44/LMS-to-uPnP. I may add or remove options in the future and change the 'default setting based upon future testing and feedback. I will note this in any updates.

### Usage

The HEOS players can be controlled as a normal ROON endpoint. Grouping is done through standard ROON grouping but behind the scenes these are translated to HEOS groups and you will see the change occure in the HEOS app.

### Known Limitations

Individaully grouped players can have their volume changed and be muted (either in ROON or the Heos app).

Group volume control of all devices in a group is not possible from ROON .

Pausing a device from Roon and then re-starting from HEOS will result in an error message (in HEOS) and returning to the start of the track.

Skipping to next track in ROON playlist is not possible from HEOS.

Devices will show "Streaming from LMS" on their display and in the HEOS app.

Cover art and metadata are not shown on the HEOS app or on the playback device.

Track progress on HEOS device and app does not show a track duration and resets after pause.

Clicking "ok" in the Heos app should remove the error.



Please report any issues via GitHub or raise on the ROON communuty site.

Enjoy!



### Acknowledgements

Thanks to Juliuscc for the development of heos-api - a superb tool!

Learn more about using heos-api at:

-   [The GitHub page](https://github.com/juliuscc/heos-api)
-   [HEOS CLI Protocol Specification](http://rn.dmglobal.com/euheos/HEOS_CLI_ProtocolSpecification.pdf)


Thanks to philippe44 for development of Squeeze2upnp. None of this would have been possible without the C binaries that allow HEOS players to emulate SlimDevices

-  [Squeeze2UPnP] (https://github.com/philippe44/LMS-to-uPnP)

Learn

## Contributing

Please send issues and pull requests with your problems or ideas!
