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

const ffprobe = require('node-ffprobe');

const formatDuration = require('format-duration');

DiscordClient.on('ready', function() {
	console.log("Ready.");
	//console.log(DiscordClient.channels);
});

var streams_w = {};
var vols = {};
var channel_designations = {};
var queue = {};
var lists = {};
var now_playing = {};

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

function getMD5Hash(data) {
	return crypto.createHash('md5').update(data).digest("hex");
}

function isCached(list, index) {
	var song = list.library[index];

	if(song.url.substr(0, 7) == "file://") {
		var path = song.url.substr(7);
		if(fs.existsSync(path)) {
			return path;
		}

		return null;
	}

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
	if(song.url.substr(0, 7) == "file://") {
		var path = song.url.substr(0, 7);
		callback(fs.createReadStream(path), path);
		return;
	}

	var path = __dirname + "/music_cache/" + getURLHash(song.url);

	var stream = fs.createWriteStream(path);

	var video = youtubedl(song.url, ["--format=bestaudio"], {maxBuffer: 1000*512});
	video.pipe(stream);

	video.on('end', function() {
		callback(fs.createReadStream(path), path);
	});
}

function getVoiceChannelName(guildID) {
	var def_rooms = settings.discord.try_channels;
	var guild = DiscordClient.guilds.get(guildID);

	if(guildID in channel_designations) {
		room = channel_designations[guildID]
		if(!guild.channels.exists("name", room)) {
			most_recent_text_channel[guildID].sendMessage(":question: *" + room + "* does not exist. Falling back to default.");

			for(var i in def_rooms) {
				var def_room = def_rooms[i];

				if(guild.channels.exists("name", def_room)) {
					var room = def_room;
					channel_designations[guildID] = def_room;
					break;
				}
			}
		}
	} else {
		for(var i in def_rooms) {
			var def_room = def_rooms[i];

			if(guild.channels.exists("name", def_room)) {
				var room = def_room;
				channel_designations[guildID] = def_room;
				break;
			}
		}
	}

	console.log("GVCN: GID " + guildID);
	console.log("GVCN: CD " + channel_designations);
	console.log("GVCN: ROOM " + room);

	return room;	
}

function startStreaming(rstream, channel) {
	//console.log(channel);
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

				var queue_in_use = queue[guildID]["list"];
				var adding = true;
				if(queue[guildID]["user_queue"].length > 0) {
					console.log("using the user queue...");
					queue_in_use = queue[guildID]["user_queue"]
					adding = false;
				}

				if(queue_in_use.length > 0) {
					console.log("CONTINUING IN QUEUE...");
					var next = queue_in_use.splice(0, 1)[0];
					console.log(next);
					if(adding) {
						addToQueue(guildID, 1);
					}
					getListData(queue[guildID]["cur_list"], function(source) {
						setTimeout(function() {
							playTrack(null, guildID, source, next);
						}, settings.defaults.track_delay*1000);
					});
				}
			});
		})
		.catch(console.error);
}

function addDurationToNPStatus(notif, str, path) {
	if(notif) {
		ffprobe(path, function(err, probeData) {
			if(err) {
				console.log(err);
				return;
			}

			if("duration" in probeData.streams[0]) {
				if(typeof probeData.streams[0].duration === "number") {
					var duration = probeData.streams[0].duration*1000;
				}
			}
			if(!duration) {
				if("duration" in probeData.format) {
					var duration = probeData.format.duration*1000;
				}
			}

			notif.edit(str + " `[" + formatDuration(duration) + "]`");
		});
	}
}

function sendNowPlayingNotif(channel, np, path) {
	now_playing[channel.guild.id] = np;

	if(!settings.enable.now_playing_notifs) {
		return;
	}

	var str = ":musical_note: **" + np.title + "**";

	if("artist" in np) {
		str = str + " by *" + np.artist + "*";
	}

	channel.sendMessage(str)
		.then(message => {
			addDurationToNPStatus(message, str, path);
		});
}

function playTrack(channel, guildID, list, to_play) {
	if(!channel) {
		channel = most_recent_text_channel[guildID];
	}

	queue[guildID]["skippers"] = [];

	if(!list) {
		channel.sendMessage("list was empty, this shouldn't happen?");
		return;
	}

	console.log("to_play: " + to_play.index);
	var index = to_play.index;
	var np = list.library[index];

	if(!np) {
		channel.sendMessage("np was undefined, this shouldn't happen?");
		return;
	}

	console.log("Playing " + np.title + " in \"" + channel.guild.name + "\" (ID " + guildID + ")");
	console.log(np);

	if(!settings.enable.caching) {
		if(np.url.substr(0, 7) == "file://") {
			sendNowPlayingNotif(channel, np, np.url.substr(7));
			startStreaming(fs.createReadStream(np.url.substr(7)), channel);
			return;
		}

		if(guildID in streams_w) {
			if(streams_w[guildID]) {
				streams_w[guildID].end();	
			}
		}

		streams_w[guildID] = fs.createWriteStream('/tmp/discord-mus-' + guildID);

		var video = youtubedl(np.url, ["--format=ogg/mp3/aac/bestaudio"], {maxBuffer: 1000*512});
		video.pipe(streams_w[guildID]);

		video.on('end', function() {
			sendNowPlayingNotif(channel, np, '/tmp/discord-mus-' + guildID);
			startStreaming(fs.createReadStream('/tmp/discord-mus-' + guildID), channel);
		});
	} else {
		var path = isCached(list, index);
		console.log("PATH: " + path);

		if(path) {
			sendNowPlayingNotif(channel, np, path);
			startStreaming(fs.createReadStream(path), channel);
		} else {
			console.log("CACHING...");
			cacheTrack(list, index, function(stream, new_path) {
				console.log("DONE.");

				sendNowPlayingNotif(channel, np, new_path);
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

	generateUIDs(data["library"]);

	return data;
}

function generateUIDs(library) {
	for(var i in library) {
		var song = library[i];
		song.uid = getMD5Hash(song.artist + song.title).substr(0, 8);
	}
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
			/*if(cur_list.indexOf(choice) > -1) {
				continue;
			}*/
			if(cur_list.filter(function(x) {
				return x.index == choice;
			}).length > 0) {
				console.log("already queued " + choice);
				continue;
			}

			//this makes [object Object] spam now, kinda irrelevant now anyways too
			//console.log("LIST AS OF NOW: " + cur_list);
			cur_list.push({
				"author": -1,
				"index": choice
			});
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

function getDeafenedCount(voice_channel) {
	var deaf = 0;
	/* why not just... an array of objects... */
	/* nooo... gotta re-invent the wheel... */
	for(var member of voice_channel.members.values()) {
		if(member.selfDeaf || member.serverDeaf) {
			deaf++;
		}
	}

	return deaf;

	/* can we go back to ES5 im tired of all this milennial crap */
}

function getListDetailRow(index, small, callback) {
	getListData(index, function(list) {
		var row = [];

		row.push(":headphones: " + list["name"] + " :headphones: **(ID: " + (parseInt(index)+1).toString() + ")**");
		if(list["format"] == "discordfm") {
			row.push(":radio: *This is a Discord.FM library*");
		}

		try {
			if(index == queue[message.guild.id]["cur_list"]) {
				row.push(":warning: **PLAYLIST CURRENTLY ACTIVE** :warning:");
			}
		} catch(err) {
			// ignore
		}

		if(!small) {
			row.push(":busts_in_silhouette: **Managed By:** " + list["manager"]);
			row.push(":clock2: **Last Updated**: " + list["last_mod"]["str"]);
			row.push(":straight_ruler: **Length:** " + list["library"].length.toString() + " songs");
		}

		callback(row);
	});
}

function getQueue(guildID) {
	var list_index = queue[guildID]["cur_list"];

	if(!("list" in queue[guildID])) {
		queue[guildID]["list"] = [];
	}
	var main_list = queue[guildID]["list"].slice(1);

	if(!("user_queue" in queue[guildID])) {
		queue[guildID]["user_queue"] = [];
	}
	var user_list = queue[guildID]["user_queue"];

	return user_list.concat(main_list);
}

function findTrackByUID(library, uid) {
	var wanted = library.filter(function(song) {
		return song.uid == uid;
	});

	if(!wanted.length) {
		return "This track does not exist.";
	}

	if(wanted.length > 1) {
		return "There are songs that also have this UID present. Please alert a developer and mention which list is currently active.\nThis is a hash collision.";
	}

	return wanted[0];
}

DiscordClient.on('message', function(message) {
	if(message.channel.type == "dm") {
		return;
	}

	if(message.author.bot) {
		return;
	}
	
	console.log("ROOM NAME: " + getVoiceChannelName(message.guild.id));
	var room = message.guild.channels.find("name", getVoiceChannelName(message.guild.id));
	var whom = message.guild.members.get(message.author.id);

	if(whom.voiceChannel) {
		if(!(whom.voiceChannel.equals(room))) {
			if(!(whom.hasPermission("KICK_MEMBERS"))) {
				return;
			}
		}
	} else {
		if(!(whom.hasPermission("KICK_MEMBERS"))) {
			return;
		}
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

					var queue_in_use = queue[guildID]["list"];
					if(queue[guildID]["user_queue"].length > 0) {
						console.log("using the user queue... (play cmd)");
						queue_in_use = queue[guildID]["user_queue"]
					}
					
					if(_c) {
						console.log("connected...");
						if(!_c.speaking) {
							getListData(queue[guildID]["cur_list"], function(source) {
								playTrack(message.channel, guildID, source, queue_in_use[0]);
							});
						}
					} else {
						getListData(queue[guildID]["cur_list"], function(source) {
							playTrack(message.channel, guildID, source, queue_in_use[0]);
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
							if(getDeafenedCount(connection.channel) == connection.channel.members.size-1) {
								message.reply(":raised_hand: Everyone is deafened, not resuming.");
								return;
							}
							if(connection.channel.members.size == 1) {
								message.reply(":raised_hand: No one is in " + connection.channel.name + ", not resuming.");
								return;
							}

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
							console.log("Moved to " + channel.name + " in " + message.guild.name);

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
					
					var small = false;
					if(settings.lists.length >= 8) {
						small = true;
					}

					message.channel.sendMessage("Fetching lists...")
						.then(progress_msg => {
							message.channel.startTyping();

							for(var i in settings.lists) {
								getListDetailRow(i, small, function(row) {
									rows.push(row);

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
										progress_msg.delete();
										message.channel.stopTyping();
									}
								});
							}
						});
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

					if(params[3] == "detail") {
						getListDetailRow(index, false, function(row) {
							message.channel.sendMessage(row.join("\n"));
						});

						return;
					}
				}

				getListData(index, function(list) {
					var connection = message.guild.voiceConnection;
					if(connection) {
						if(connection.player) {
							connection.player.dispatcher.end("stopped");
						}
					}

					var guildID = message.guild.id;

					if(!(guildID in queue)) {
						queue[guildID] = {};
					}
					queue[guildID]["list"] = [];
					queue[guildID]["user_queue"] = [];
					queue[guildID]["cur_list"] = index;

					message.reply("Set the active list to " + list.name + ", managed by " + list.manager);
				});
			}

			else if(params[1] == "queue") {
				if(params.length < 3) {
					var lines = [];
					var overall_queue = getQueue(message.guild.id);
					getListData(queue[message.guild.id]["cur_list"], function(list) {
						// purposely starting at 1, 0 is the current track
						for(var i=0; i<10; i++) {
							if(i >= overall_queue.length) {
								break;
							}

							var song = overall_queue[i].index;
							console.log("GETTING INFO FOR " + song + " IN " + list.name);

							var str = (i+1).toString() + ". **" + list.library[song]["title"] + "**";
							if("artist" in list.library[song]) {
								str = str + " by *" + list.library[song]["artist"] + "*";
							}
							lines.push(str);
						}

						message.reply("\n" + lines.join("\n"));	
					});

					return;
				}

				getListData(queue[message.guild.id]["cur_list"], function(list) {
					if(!("user_queue" in queue[message.guild.id])) {
						queue[message.guild.id]["user_queue"] = [];
					}

					var user_queued_already = queue[message.guild.id]["user_queue"].filter(function(entry) {
						return entry.author == message.author.id;
					});

					/* TODO: remove hardcoded limit of 5 */
					if(user_queued_already.length > 5) {
						message.reply("You can only have a maximum of 5 in the queue at a time.");
						return;
					}

					wanted = findTrackByUID(list.library, params[2]);

					if(typeof wanted !== "string") {
						queue[message.guild.id]["user_queue"].push({
							"author": message.author.id,
							"index": list.library.indexOf(wanted)
						});

						message.reply(":notepad_spiral: Queued up **" + wanted.title + "**");
					} else {
						message.reply(wanted);
					}
				});
			}

			else if(params[1] == "source") {
				message.delete();
				message.author.sendMessage(":wave: Source for the currently playing song:\n" + now_playing[message.guild.id]["url"]);
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

			else if(params[1] == "search") {
				if(params.length < 3) {
					return;
				}

				var guildID = message.guild.id;
				var page = 0;
				if(!isNaN(parseInt(params[2]))) {
					page = parseInt(params[2])-1;
					var terms = params.slice(3);
				} else {
					var terms = params.slice(2);
				}
				var found = [];

				terms = terms.map(function(term) {
					return term.toLowerCase();
				});

				getListData(queue[guildID]["cur_list"], function(list) {
					for(var i in list.library) {
						var song = list.library[i];

						terms.some(function(v) {
							if(song.title.toLowerCase().indexOf(v) > -1) {
								found.push("`" + song.uid + "` **" + song.title + "** by *" + song.artist + "*");
							} else {
								if("artist" in song) {
									if(song.artist.toLowerCase().indexOf(v) > -1) {
										found.push("`" + song.uid + "` **" + song.title + "** by *" + song.artist + "*");
									}
								}
							}
						});
					}

					var len = parseInt(found.length.toString());
					var show_amount = settings.defaults.search_results;
					var max = Math.ceil(len/show_amount);
					page = Math.min(Math.max(page, 0), max-1);
					var diff = 0;

					if(found.length > show_amount) {
						found = found.slice(page*show_amount, (page+1)*show_amount);
						diff = len - found.length;
						found.push("**and " + diff.toString() + " more results.** *(page " + (page+1).toString() + "/" + max.toString() + ")*");
					}

					message.channel.sendMessage(found.join("\n"));
				});
			}

			else if(params[1] == "show") {
				if(params.length < 3) {
					return;
				}

				if(!params[2]) {
					return;
				}

				getListData(queue[message.guild.id]["cur_list"], function(list) {
					var wanted = findTrackByUID(list.library, params[2]);

					if(typeof wanted === "string") {
						message.reply(wanted);
						return;
					}

					var out = [];
					
					var str = ":musical_note: **" + wanted.title + "**";
					if("artist" in wanted) {
						str = str + " by *" + wanted.artist + "*";
					}
					out.push(str);

					if(wanted.timestamp > 0) {
						var d = new Date(wanted.timestamp*1000);
						out.push(":clock2: **Added On:** " + d.toString());
					} else {
						out.push(":clock2: **Added On:** Unknown");
					}

					out.push(":name_badge: **Unique Identifier**: `" + wanted.uid + "`");

					out.push("`" + wanted.url + "`");

					message.channel.sendMessage(out.join("\n"));
				});
			}

			else if(params[1] == "help") {
				var lines = [
					"***THIS IS STILL A WORK IN PROGRESS!***",
					"*Source code:* https://github.com/TheBlackParrot/discord-music-bot",
					"*Sample lists:* https://github.com/TheBlackParrot/discord-music-bot-lists",
					"",
					"**Commands**:",
					"`list [number]`: Shows the available playlists if blank, switches to the specified playlist if not.",
					"`list [number] refresh`: *(KICK_MEMBERS permission needed!)* Refreshes the cached data for this list.",
					"`list [number] detail`: Shows more details about a list.",
					"`play`: Starts playing from the playlist.",
					"`queue`: Shows what will play next.",
					"`queue [song uid]`: Queues a song to play [limit of 5 per user].",
					"`pause`/`toggle`: Pauses/resumes playback",
					"`stop`: Stops playback.",
					"`channel [voice channel]`: *(KICK_MEMBERS permission needed!)* Switches the voice channel to connect to.",
					"`vol`/`volume [0-100]`: Changes the volume.",
					"`source`: DM's the source for the currently playing song.",
					"`list_format`: DM's an example list to show what playlists should look like.",
					"`skip`: Votes to skip a song. 50% majority of the voice channel is needed.",
					"`skip force`: *(KICK_MEMBERS permission needed!)* Forcibly skips a song, disregarding votes.",
					"`search [page#] [terms]`: Search through the active playlist, looking at titles and artists.",
					"`show [song uid]`: Shows extra details about a track."
				];

				message.author.sendMessage(lines.join("\n"));
				message.delete();
			}

			else if(params[1] == "list_format") {
				var author = message.author;

				fs.readFile(__dirname + "/example.txt", function(err, data) {
					if(!err) {
						author.sendMessage(data.toString("utf8"))
							.catch(console.error);
					}
				});

				fs.readFile(__dirname + "/example_alt.txt", function(err, data) {
					if(!err) {
						author.sendMessage(data.toString("utf8"))
							.catch(console.error);
					}
				});

				message.delete();
			}
		}
	}
});

DiscordClient.on('voiceStateUpdate', function(oldMember, newMember) {
	console.log("voiceStateUpdate");

	var connection = newMember.guild.voiceConnection;
	if(!connection) {
		return;
	}
	if(!connection.player) {
		return;
	}

	var channel = connection.channel;
	var dispatcher = connection.player.dispatcher;
	var text_channel = most_recent_text_channel[channel.guild.id];

	if(channel.members.size <= 1) {
		if(!dispatcher.paused) {
			dispatcher.pause();
			text_channel.sendMessage(":raised_hand: Paused due to lack of listeners. Use `toggle` or `pause` to resume.");
		}
	}

	var deaf = getDeafenedCount(channel);

	if(deaf >= channel.members.size-1) {
		if(!dispatcher.paused) {
			dispatcher.pause();
			text_channel.sendMessage(":raised_hand: Paused due to lack of listeners. Use `toggle` or `pause` to resume.");
		}		
	}
});

DiscordClient.login(settings.discord.token);