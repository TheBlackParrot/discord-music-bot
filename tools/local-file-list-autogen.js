const fs = require('fs');
const path = require('path');
const ffprobe = require('node-ffprobe');

var dir = process.argv[2]

// https://gist.github.com/kethinov/6658166#gistcomment-1921157
function walkSync(dir, filelist) {
    var files = fs.readdirSync(dir);
    filelist = filelist || [];

    files.forEach(function(file) {
        if(fs.statSync(path.join(dir, file)).isDirectory()) {
            filelist = walkSync(path.join(dir, file), filelist);
        }
        else {
            filelist.push(path.join(dir, file));
        }
    });
    return filelist;
};

var valid_audio = [
	".mp3",
	".wav",
	".flac",
	".ogg",
	".m4a",
	".aac",
	".opus"
];

if(fs.existsSync(dir)) {
	var files = walkSync(dir);
	var main = {
		"name": "Auto Generated Playlist",
		"manager": "NotFilledIn#1234",
		"fmt_version": 1,

		"library": []
	};

	var now = Math.floor(Date.now()/1000);

	var promises = files.map(function(file) {
		return new Promise(function(resolve, reject) {
			if(valid_audio.indexOf(path.extname(file)) < 0) {
				resolve();
				return;
			}

			ffprobe(file, function(err, probeData) {
				if(err) {
					resolve();
					return;
				}

				if(!("metadata" in probeData)) {
					resolve();
					return;
				}

				var metadata = probeData.metadata;

				var parts = {
					"url": "file://" + file,
					"artist": metadata.artist.toString(),
					"title": metadata.title.toString(),
					"timestamp": now
				};

				main.library.push(parts);
				resolve();
			});
		});
	});

	Promise.all(promises)
		.then(function() {
			fs.writeFileSync("generator-output.json", JSON.stringify(main), {"mode": "765"});
		})
		.catch(console.error);
}