
# RHEOS


A ROON Extension to allow  control of Denon/Marantz HEOS devices from ROON.

## Features

-   🔎 Automatic discovery of HEOS devices and make them available as ROON audio devices (via UPnP).
-   🎯 Bi-directional Control of player play, pause, previous, volume, mute and grouping within HEOS players from ROON or Heos App.
-   🎶 Group HEOS devices from ROON. Uses HEOS grouping to ensure synchronization with other HEOS players. Only groups HEOS players.
-   🔗 Create fixed groups for ROON outputs. Allowsvolume  control of all grouped players from ROON interface using single control
-   🔊 Does not use AirPlay so can stream at Hi-Resolution for HS2 players.
-   🚫 Written in pure Javascript / Nodejs with limited module dependencies (heos-api, squeeze2UPnP, Xml2js,ip)


## Installation

Install/Update nodejs for your system (tested on Windows, Ubuntu 22.04.1 LTS, and Raspberry pi 4) . This requires at least Node v16.0. [https://nodejs.org/en/download/]

The simplest way to install this is using the roon-extension-manager https://github.com/TheAppgineer/roon-extension-manager 
Tested with a raspberry pi3 (Ubuntu 32 bit), pi 4(3Ubuntu 2 and 64bit) and NUC (Ubuntu 22.04.1 LTS amd64)

Next option is to install docker and pull a copy from my repo : https://hub.docker.com/repository/docker/rheos/roon-extension-rheos

To manually install (e.g. if you want to run on a Windows box) this works :-

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

Players will appear as Squeezebox Devices in ROON Settings -> Audio. Each device is intially unamed and to enable in ROON edit a device name(Edit Rooms -> Select / Edit Name).  If they do not appear make sure you are not running Logitech Media Server (LMS) and do not have another version of RHEOS enabled onthe system.

If you have HS2 devices you may wish to enable Hi-Res streaming (192 kHz 24 Bit Flac). Do this in Settings-> Extension -> RHEOS -> Settings for each HS2 player. This may increase network load and success will depend upon wired connections and a fast ethernet. All players default to CD quality 48kHz 24 bit.

The only other settings are an IP address of the Heos Player you would like to use as the main connection. All HEOS commands are sent through this and RHEOS listens for changes to any of your players through this. If there is a problem discovering your HEOS players you can try to edit this address. Heos devices must by on the same local network as the Roon Serverand the device running the Rheos app.  Once a connection has been made, all HEOS player IPs are stored and can be selected from the drop-down. If none has been found you may enter the IP address, if you can find this from your router DHCP table.

Roon Extension Host IP Address shows the discovered IP address of the device you are using to run RHEOS. You may want to try editing this if for some reason network discovery is not working.

Under RHEOS UPnP Settings there are options to select buffer-size, output-size, stream-length, seek-after-pause, volume-on-play, volume-feedback, FLAC-header, keep-alive, next-delay, send-meta-data and send-cover-art. The defaults are the settings I have found to work best across a variety of HEOS players so I recoomend not adjusting these unless you have specific needs or something isn't working for you. Full information on them can be found here https://github.com/philippe44/LMS-to-uPnP. I may add or remove options in the future and change the 'default setting based upon future testing and feedback. I will note this in any updates. Metadata (now playing content and album art) does not fuction and the Heos app will not display album art or track info whilst playing from ROON.

### Usage

The HEOS players can be controlled as a normal ROON endpoint. Grouping is done through standard ROON grouping but behind the scenes these are translated to HEOS groups and you will see the change appear in the HEOS app.

Fixed groups can be created from any group created using ROON or HEOS. To create a fixed grouop that is automatically regenerated when a fixed group output is played go to settings -> groups 
All present ROON/HEOS groups will be listed - and shown initially as variable. 
To have as a fixed group select from the drop down and this will be created. 
If a fixed group with the same players has been previously created (even with a different lead player or order of players) it will appear as a new ROON output.
Selecting play will group the HEos players and start play back. Pause will ungroup and stop playback. 
If the group has never been created bfore it needs to be enabled in ROON using Settings -> Audio -> Squeezebox where the group will appear with the HEOS group name. 
This can be edited as needed in ROON and enabled or disabled as needed. On playing the group will be identified as a ROON group i.e. "player" + x and the chisen name will appear as the last player in the group with a cvolume control that will controll all other players in the group (as presently in the HEOS control app).

Individaul and  fixed group players can have their volume changed and be muted (either in ROON or the Heos app).

### Known Limitations



Pausing a device from Roon and then re-starting from HEOS will result in an error message (in HEOS) and returning to the start of the track.

Skipping to next track in ROON playlist is not possible from HEOS.

Devices will show "Streaming from LMS" on their display and in the HEOS app.

Cover art and metadata are not shown on the HEOS app or on the playback device.
Windows firewalls can cause some issues. If a HEOS device is found and selected but doesnt play even a when CD resolution is selected take a look at the firewall. Allow two specific executable files to be passed throu ./ROON/UPnP/Bin/RHEOS2UPnP and ./ROON/UPnP/Bin/Squeezelite/



#### Please report any issues via GitHub or raise on the ROON communuty site.

Enjoy!



### Acknowledgements

Thanks to Juliuscc for the development of heos-api - a superb tool!

Learn more about using heos-api at:

-   [The GitHub page](https://github.com/juliuscc/heos-api)
-   [HEOS CLI Protocol Specification](http://rn.dmglobal.com/euheos/HEOS_CLI_ProtocolSpecification.pdf)


Thanks to philippe44 for development of Squeeze2UPnP. None of this would have been possible without the C binaries that allow HEOS players to emulate SlimDevices

-   [Squeeze2UPnP](https://github.com/philippe44/LMS-to-uPnP)


## Contributing

Please send issues and pull requests with your problems or ideas!
