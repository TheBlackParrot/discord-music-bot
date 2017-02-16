const Discord = require('discord.js');
const DiscordClient = new Discord.Client();

const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

const settings = require('./settings.json');

var youtubedl = require('youtube-dl');
const streamOptions = { seek: 0, volume: settings.defaults.volume/100 };

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
			dispatcher.passes = settings.defaults.dispatcher_passes;

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
						setTimeout(function() {
							playTrack(null, guildID, source, queue[guildID]["list"][0]);
						}, settings.defaults.track_delay*1000);
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
		var str = ":musical_note: **" + now_playing.title + "**";
		if("artist" in now_playing) {
			str = str + " by *" + now_playing.artist + "*";
		}
		channel.sendMessage(str);
	}

	if(!settings.enable.caching) {
		if(guildID in streams_w) {
			if(streams_w[guildID]) {
				streams_w[guildID].end();	
			}
		}

		streams_w[guildID] = fs.createWriteStream('/tmp/discord-mus-' + guildID);

		var video = youtubedl(now_playing.url, ["--format=ogg/mp3/aac/bestaudio"], {maxBuffer: 1000*512});
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

function parseSVData(data, separator) {
	var lines = data.split("\n").map(function(x) {
		return x.trim();
	});

	var output = {
		"library": []
	};

	for(var i in lines) {
		var line = lines[i];

		var params = line.split(separator).map(function(x) {
			return x.trim();
		});

		if(params.length < 4 || line.charAt(0) == "#") {
			continue;
		}

		var obj = {
			"url": params[0],
			"artist": params[1],
			"title": params[2],
			"timestamp": params[3]
		};

		output["library"].push(obj);
	}

	// the last line denotes list info
	if(line.charAt(0) == "#") {
		output["name"] = params[0].substr(1),
		output["manager"] = params[1],
		output["fmt_version"] = params[2]
	} else {
		console.log("couldn't find info line");
		return null;
	}

	return output;
}

function parseDiscordFMData(data) {
	var parsed = {
		"fmt_version": 1,
		"library": []
	};

	for(var i in data) {
		var row = data[i];
		var x = {};

		if("url" in row) {
			x["url"] = row["url"];
			x["title"] = row["title"];
		} else {
			if(row["service"] == "YouTubeVideo") {
				x["url"] = "https://www.youtube.com/watch?v=" + row["identifier"];
			}
		}

		// no sort of timestamp is ever provided
		x["timestamp"] = 0;

		if("title" in x && "url" in x) {
			parsed.library.push(x);
		}
	}

	return parsed;

	/*
		i'm guessing even though they have to verify requests, they just throw links at a script
		and let it parse everything. titles aren't consistent, object formatting changed at some point...
		just ugh. maybe this is why they're working on an API.

		this is why there's a check to see if "artist" even exists on this side of things, it doesn't
		exist in discord.fm's library format.
	*/
}

function injectCustomData(data, source) {
	for(var i in source.inject) {
		data[i] = source.inject[i];
	}

	data["url"] = source.path;
	data["last_mod"] = {
		"int": getLastModTime(data["library"]),
		"str": getLastModTime(data["library"], true)
	};
	data["format"] = source.format;

	return data;
}

function getLastModTime(library, format) {
	var highest = 0;
	for(var i in library) {
		var entry = library[i];

		if(entry["timestamp"] > highest) {
			highest = entry["timestamp"];
		}
	}

	if(format) {
		if(highest <= 0) {
			return "Unknown";
		}
		
		var d = new Date(highest*1000);
		return d.toString();
	} else {
		return highest;
	}
}

/*
	tab seperated values
	comma "
	colon "
	pipe "
	caret "
	percent "
	dollar "
	at-sign "
	non-breaking space "
*/

var valid_separator_chars = {
	"tsv": "\t",
	"csv": ",",
	"clsv": ":",
	"psv": "|",
	"crsv": "^",
	"prsv": "%",
	"dsv": "$",
	"asv": "@",
	"nbspsv": " "
};

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
			var raw = fs.readFileSync(source.path, 'utf8');

			if(source["format"] == "json") {
				var data = JSON.parse(raw);
			} else if(source["format"] in valid_separator_chars) {
				var data = parseSVData(raw, valid_separator_chars[source["format"]]);
			} else if(source["format"] == "discordfm") {
				var data = parseDiscordFMData(JSON.parse(raw));
			}

			data = injectCustomData(data, source);

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
						var raw = res.body.toString();

						if(source["format"] == "json") {
							var data = JSON.parse(raw);
						} else if(source["format"] in valid_separator_chars) {
							var data = parseSVData(raw, valid_separator_chars[source["format"]]);
						} else if(source["format"] == "discordfm") {
							var data = parseDiscordFMData(JSON.parse(raw));
						}

						data = injectCustomData(data, source);

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

function skipTrack(connection) {
	if(connection) {
		if(connection.player) {
			connection.player.dispatcher.end("skipped");
			most_recent_text_channel[connection.channel.guild.id].sendMessage(":track_next: **Skipped track.**");
		}
	}
}

DiscordClient.on('message', function(message) {
	if(message.channel.type == "dm") {
		return;
	}

	if(message.author.bot) {
		return;
	}

	var room = message.guild.channels.find("name", getVoiceChannelName(guildID));
	var whom = message.guild.members.get(message.author.id);

	if(whom) {
		if(!(whom.voiceChannel.equals(room))) {
			if(!(whom.hasPermission("KICK_MEMBERS"))) {
				return;
			}
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
					var rows = [];
					for(var i in settings.lists) {
						getListData(i, function(list) {
							var row = [];
							var id = settings.lists.findIndex(item => item.path === list.url);

							row.push(":headphones: " + list["name"] + " :headphones: **(ID: " + (id+1).toString() + ")**");
							if(list["format"] == "discordfm") {
								row.push(":radio: *This is a Discord.FM library*");
							}

							try {
								if(id == queue[message.guild.id]["cur_list"]) {
									row.push(":warning: **PLAYLIST CURRENTLY ACTIVE** :warning:");
								}
							} catch(err) {
								// ignore
							}

							row.push(":busts_in_silhouette: **Managed By:** " + list["manager"]);
							row.push(":clock2: **Last Updated**: " + list["last_mod"]["str"]);
							row.push(":straight_ruler: **Length:** " + list["library"].length.toString() + " songs");

							rows.push(row);

							//lines.splice(id, 0, str);

							if(rows.length == settings.lists.length) {
								var out = [];

								for(var j in rows) {
									var lines = rows[j];

									for(var k in lines) {
										out.push(lines[k]);
									}

									out.push("");
								}

								message.channel.sendMessage(out.join("\n"));
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

						if(!(source.path in lists)) {
							return;
						}

						var _ = lists[source.path]["manager"].split(",").map(function(x) {
							return x.trim();
						});

						if(message.author.id != settings.discord.owner_id ||
							_.indexOf(message.author.username + "#" + message.author.discriminator) > -1) {

							delete lists[source.path];

							getListData(index, function(list) {
								message.reply("Refreshed " + list.name);
							});
						}

						return;
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

							var str = i.toString() + ". **" + list.library[song]["title"] + "**";
							if("artist" in list.library[song]) {
								str = str + " by *" + list.library[song]["artist"] + "*";
							}
							lines.push(str);
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
				if(params.length > 2) {
					if(params[2] == "force") {
						if(whom.hasPermission("KICK_MEMBERS")) {
							skipTrack(message.guild.voiceConnection);
							return;
						}
					}
				}

				var guildID = message.guild.id;

				if(!("skippers" in queue[guildID])) {
					queue[guildID]["skippers"] = [];
				}

				if(queue[guildID]["skippers"].indexOf(message.author.id) > -1) {
					return;
				}

				queue[guildID]["skippers"].push(message.author.id);
				console.log(queue[guildID]["skippers"]);

				if(queue[guildID]["skippers"].length / room.members.size >= 0.5) {
					skipTrack(message.guild.voiceConnection);
				} else {
					console.log(room.members.size);
					var remain = Math.ceil(room.members.size / 2) - queue[guildID]["skippers"].length;
					message.reply("Your skip has been acknowledged, " + remain.toString() + " more must skip.");
				}
			}

			else if(params[1] == "help") {
				var lines = [
					"***THIS IS STILL A WORK IN PROGRESS!***",
					"*Source code:* https://github.com/TheBlackParrot/discord-music-bot",
					"*Sample lists:* https://github.com/TheBlackParrot/discord-music-bot-lists",
					"",
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