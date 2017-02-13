const Discord = require('discord.js');
const DiscordClient = new Discord.Client();

const fs = require('fs');
const crypto = require('crypto');

const settings = require('./settings.json');

var youtubedl = require('youtube-dl');
const streamOptions = { seek: 0, volume: 1 };

const mkdirp = require('mkdirp');

const request = require('then-request');

DiscordClient.on('ready', function() {
	console.log("Ready.");
	//console.log(DiscordClient.channels);
});

var streams_w = {};
var vols = {};
var channel_designations = {};
var queue = {};
var lists = {};

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}


var most_recent_text_channel = {};

/*
cache folder structure:
	root/music_cache/[manager]/[safe_name]/[song_uid]
*/

function getURLHash(url) {
	return crypto.createHash('sha256').update(url).digest("hex");
}

function isCached(list, index) {
	var song = list.library[index];

	var dir = __dirname + "/music_cache";
	var path = dir + "/" + getURLHash(song.url);

	mkdirp.sync(dir, {"mode": "754"});

	if(fs.existsSync(path)) {
		return path;
	}

	return null;
}

function cacheTrack(list, index, callback) {
	var song = list.library[index];
	var path = __dirname + "/music_cache/" + getURLHash(song.url);

	var stream = fs.createWriteStream(path);

	var video = youtubedl(song.url, ["--format=bestaudio"], {maxBuffer: 1000*512});
	video.pipe(stream);

	video.on('end', function() {
		callback(fs.createReadStream(path));
	});
}

function getVoiceChannelName(guildID) {
	var room = "Music";
	if(guildID in channel_designations) {
		room = channel_designations[guildID]
	}

	return room;	
}

function startStreaming(rstream, channel) {
	var _c = channel.guild.voiceConnection
	if(_c) {
		if(_c.player) {
			_c.player.dispatcher.end();
		}
	}

	var guildID = channel.guild.id;

	var room = getVoiceChannelName(guildID);

	channel.guild.channels.find("name", room).join()
		.then(connection => {
			var vol = 1;
			if(guildID in vols) {
				vol = Math.min(Math.max(parseInt(vols[guildID]), 0), 100)/100;
			}

			const dispatcher = connection.playStream(rstream, {seek: 0, volume: vol});
			dispatcher.passes = 2;

			dispatcher.on('end', function(reason) {
				console.log("PLAYBACK FINISHED.");

				if(reason == "stopped") {
					return;
				}

				if(queue[guildID]["list"].length > 0) {
					console.log("CONTINUING IN QUEUE...");
					queue[guildID]["list"].splice(0, 1);
					addToQueue(guildID, 1);
					getListData(queue[guildID]["cur_list"], function(source) {
						playTrack(null, guildID, source, queue[guildID]["list"][0]);
					});
				}
			});
		})
		.catch(console.error);
}

function playTrack(channel, guildID, list, index) {
	if(!channel) {
		channel = most_recent_text_channel[guildID];
	}

	queue[guildID]["skippers"] = [];

	if(!list) {
		channel.sendMessage("list was empty, this shouldn't happen?");
		return;
	}

	var now_playing = list.library[index];

	if(!now_playing) {
		channel.sendMessage("now_playing was undefined, this shouldn't happen?");
		return;
	}

	console.log("Playing " + now_playing.title + " in \"" + channel.guild.name + "\" (ID " + guildID + ")");

	if(settings.enable.now_playing_notifs) {
		channel.sendMessage(":musical_note: **" + now_playing.title + "** by *" + now_playing.artist + "*");
	}

	if(!settings.enable.caching) {
		if(guildID in streams_w) {
			if(streams_w[guildID]) {
				streams_w[guildID].end();	
			}
		}

		streams_w[guildID] = fs.createWriteStream('/tmp/discord-mus-' + guildID);

		var video = youtubedl(now_playing.url, ["--format=bestaudio"], {maxBuffer: 1000*512});
		video.pipe(streams_w[guildID]);

		video.on('end', function() {
			startStreaming(fs.createReadStream('/tmp/discord-mus-' + guildID), channel);
		});
	} else {
		var path = isCached(list, index);
		console.log("PATH: " + path);

		if(path) {
			startStreaming(fs.createReadStream(path), channel);
		} else {
			console.log("CACHING...");
			cacheTrack(list, index, function(stream) {
				console.log("DONE.");
				startStreaming(stream, channel);
			});
		}
	}
}

function getListData(index, callback) {
	var source = settings.lists[index];
	console.log(source);

	if(source.path in lists) {
		console.log("CACHED LIST");
		callback(lists[source.path]);
		return;
	}

	switch(source["type"]) {
		case "local":
			var data = JSON.parse(fs.readFileSync(source.path, 'utf8'));
			data["url"] = source.path;

			lists[source.path] = data;
			callback(data);
			break;

		case "remote":
			setTimeout(function() {
				request('GET', source.path).done(function(res) {
					console.log("RESPONSE CODE: " + res.statusCode.toString());
					if(res.statusCode >= 300) {
						var err = new Error('Server responded with status code ' + this.statusCode + ':\n' + this.body.toString());
						throw err;
					} else {
						var data = JSON.parse(res.body.toString());
						data["url"] = source.path;

						lists[source.path] = data;
						callback(data);
					}
				});
			}, 200);
			break;
	}
}

function addToQueue(guildID, amount) {
	var list_index = queue[guildID]["cur_list"];

	try {
		var cur_list = queue[guildID]["list"];
	} catch(err) {
		var cur_list = [];
	}

	console.log("Adding " + amount + " to " + guildID);

	var source = getListData(list_index, function(source) {
		var entries = source.library;

		amount = Math.min(Math.max(amount, 0), entries.length)

		var added = 0;
		while(added < amount) {
			var choice = getRandomInt(0, entries.length-1);
			if(cur_list.indexOf(choice) > -1) {
				continue;
			}

			console.log("LIST AS OF NOW: " + cur_list);
			cur_list.push(choice);
			added++;
		}

		queue[guildID]["list"] = cur_list;
	});
}

DiscordClient.on('message', function(message) {
	if(message.channel.type == "dm") {
		return;
	}

	if(message.author.bot) {
		return;
	}

	var room = message.guild.channels.find("name", getVoiceChannelName(guildID));
	var whom = room.members.get(message.author.id);

	if(whom) {
		if(!(whom.voiceChannel.equals(room))) {
			return;
		}
	} else {
		return;
	}

	if(message.isMentioned(DiscordClient.user)) {
		var params = message.content.split(" ")
		// console.log(params)

		if(params.length > 1) {
			if(params[1] == "play") {
				most_recent_text_channel[message.guild.id] = message.channel;

				if(message.guild.id in queue) {
					var _c = message.guild.voiceConnection;
					var guildID = message.guild.id;

					queue[guildID]["list"] = [];
					addToQueue(guildID, 10);
					
					if(_c) {
						console.log("connected...");
						if(!_c.speaking) {
							getListData(queue[guildID]["cur_list"], function(source) {
								playTrack(message.channel, guildID, source, queue[guildID]["list"][0]);
							});
						}
					} else {
						getListData(queue[guildID]["cur_list"], function(source) {
							playTrack(message.channel, guildID, source, queue[guildID]["list"][0]);
						});								
					}
				} else {
					message.reply("No list has been set! Mention me with `list` to see available lists.");
				}
			}

			else if(params[1] == "stop") {
				var connection = message.guild.voiceConnection
				if(connection) {
					if(connection.player) {
						connection.player.dispatcher.end("stopped");
						message.reply(":octagonal_sign: **Stopped playback.**");
					}
				}
			}

			else if(params[1] == "toggle" || params[1] == "pause") {
				var connection = message.guild.voiceConnection
				if(connection) {
					if(connection.player) {
						var dispatcher = connection.player.dispatcher;
						if(dispatcher.paused) {
							connection.player.dispatcher.resume();
							message.reply(":point_right: **Resumed playback.**");
						} else {
							connection.player.dispatcher.pause();
							message.reply(":raised_hand: **Paused playback.**");
						}
					}
				}			
			}

			else if(params[1] == "vol" || params[1] == "volume") {
				if(params.length < 3) {
					return;
				}

				var connection = message.guild.voiceConnection;

				vols[message.guild.id] = Math.min(Math.max(parseInt(params[2]), 0), 100)

				if(connection) {
					if(connection.player) {
						connection.player.dispatcher.setVolume(vols[message.guild.id]/100)
					}
				}
				message.reply(":control_knobs: Set volume to **" + vols[message.guild.id].toString() + "%**");
			}

			else if(params[1] == "channel") {
				if(params.length < 3) {
					return;
				}

				if(!params[2]) {
					return;
				}

				var room = params.slice(2).join(" ");

				message.guild.fetchMember(message.author.id).then(member => {
					if(member.hasPermission("KICK_MEMBERS")) {
						channel = message.guild.channels.find("name", room);
						if(channel) {
							message.reply(":door: Moved to " + channel.name)
							channel_designations[message.guild.id] = channel.name;

							var connection = message.guild.voiceConnection;
							if(connection) {
								channel.join();
							}
						}
					} else {
						message.reply(":no_entry: You do not have the KICK_MEMBERS permission.");
					}
				});
			}

			else if(params[1] == "list") {
				if(params.length < 3) {
					var lines = [];
					for(var i in settings.lists) {
						getListData(i, function(list) {
							var id = settings.lists.findIndex(item => item.path === list.url)
							var str = (id+1).toString() + ". " + list["name"];

							try {
								if(id == queue[message.guild.id]["cur_list"]) {
									str = ":white_check_mark: " + str;
								}
							} catch(err) {
								// ignore
							}

							lines.splice(id, 0, str);

							if(lines.length == settings.lists.length) {
								message.reply("\n" + lines.join("\n"));
							}
						});
					}
					return;
				}

				var index = parseInt(params[2])-1;
				if(index < 0 || index >= settings.lists.length) {
					return;
				}

				if(params.length == 4) {
					if(params[3] == "refresh") {
						var source = settings.lists[index];
						lists[source.path] = null;

						getListData(index, function(list) {
							message.reply("Refreshed " + list.name);
						});
					}
				}

				getListData(index, function(list) {
					var connection = message.guild.voiceConnection;
					if(connection) {
						if(connection.player) {
							connection.player.dispatcher.end();
						}
					}

					var guildID = message.guild.id;

					if(!(guildID in queue)) {
						queue[guildID] = {};
					}
					queue[guildID]["list"] = [];
					queue[guildID]["cur_list"] = index;

					message.reply("Set the active list to " + list.name + ", managed by " + list.manager);
				});
			}

			else if(params[1] == "queue") {
				if(params.length < 3) {
					var lines = [];
					getListData(queue[message.guild.id]["cur_list"], function(list) {
						// purposely starting at 1, 0 is the current track
						for(var i=1; i<=10; i++) {
							if(i >= queue[message.guild.id]["list"].length) {
								break;
							}

							var song = queue[message.guild.id]["list"][i];
							console.log("GETTING INFO FOR " + song + " IN " + list.name);
							lines.push(i.toString() + ". **" + list.library[song]["title"] + "** by *" + list.library[song]["artist"] + "*");
						}

						message.reply("\n" + lines.join("\n"));	
					});
				}				
			}

			else if(params[1] == "source") {
				getListData(queue[message.guild.id]["cur_list"], function(list) {
					var song = queue[message.guild.id]["list"][0];

					message.delete();

					message.author.sendMessage(":wave: Source for the currently playing song:\n" + list.library[song]["url"]);
				});
			}

			else if(params[1] == "skip" || params[1] == "next" || params[1] == ":track_next:") {
				var guildID = message.guild.id;

				if(!("skippers" in queue[guildID])) {
					queue[guildID]["skippers"] = [];
				}

				if(message.author.id in queue[guildID]["skippers"]) {
					return;
				}

				queue[guildID]["skippers"].push(message.author.id);
				console.log(queue[guildID]["skippers"]);

				if(queue[guildID]["skippers"].length / room.members.size >= 0.5) {
					var connection = message.guild.voiceConnection
					if(connection) {
						if(connection.player) {
							connection.player.dispatcher.end("skipped");
							message.channel.sendMessage(":track_next: **Skipped track.**");
						}
					}				
				} else {
					console.log(room.members.size);
					var remain = Math.ceil(room.members.size / 2) - queue[guildID]["skippers"].length;
					message.reply("Your skip has been acknowledged, " + remain.toString() + " more must skip.");
				}
			}

			else if(params[1] == "help") {
				var lines = [
					"***THIS IS STILL A WORK IN PROGRESS!***",
					"**Commands**:",
					"`list [number]`: Shows the available playlists if blank, switches to the specified playlist if not.",
					"`play`: Starts playing from the playlist.",
					"`queue`: Shows what will play next.",
					"`pause`/`toggle`: Pauses/resumes playback",
					"`stop`: Stops playback.",
					"`channel [voice channel]`: *(KICK_MEMBERS permission needed!)* Switches the voice channel to connect to.",
					"`vol`/`volume [0-100%]`: Changes the volume.",
					"`source`: DM's the source for the currently playing song.",
					"`list_format`: DM's an example list to show what playlists should look like.",
					"`skip`: Votes to skip a song. 50% majority of the voice channel is needed."
				];

				message.author.sendMessage(lines.join("\n"));
				message.delete();
			}

			else if(params[1] == "list_format") {
				fs.readFile(__dirname + "/example.txt", function(err, data) {
					if(!err) {
						message.author.sendMessage(data.toString("utf8"))
							.catch(console.error);
					}

					message.delete();
				});
			}
		}
	}
});

DiscordClient.login(settings.discord.token);