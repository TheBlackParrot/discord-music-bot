from __future__ import unicode_literals
import youtube_dl
import billboard
import json
from time import time
from math import floor

def timestamp():
	return floor(time())

ydl_opts = {
	"simulate": True,
	"min_views": 1000000
}

billboard_cache = {}

try:
	with open('billboard-cache.json', 'r', encoding='utf-8') as file:
		billboard_cache = json.load(file)
except:
	print("Couldn't load cache, assuming it doesn't exist.")

chart = billboard.ChartData('hot-100')
out = {
	"name": "Billboard Hot 100 (50) Chart",
	"manager": "TheBlackParrot#1352",
	"fmt_version": 1,
	"library": []
}

for x in range(0, 50):
	song = chart[x]
	query = "{} {}".format(song.artist, song.title)

	if query in billboard_cache:
		out["library"].append(billboard_cache[query])
		continue

	print("Adding {} - {} to the cache...".format(song.artist, song.title))

	row = {
		"title": song.title,
		"artist": song.artist,
		"timestamp": timestamp()
	}

	with youtube_dl.YoutubeDL(ydl_opts) as ydl:
		info_dict = ydl.extract_info('ytsearch1:{}'.format(query), download=False)
		video_id = info_dict["entries"][0].get("id", None)
		row["url"] = "https://youtu.be/{}".format(video_id)

	out["library"].append(row)
	billboard_cache[query] = row

with open('billboard-cache.json', 'w', encoding='utf-8') as file:
	json.dump(billboard_cache, file)

with open('billboard-list.json', 'w', encoding='utf-8') as file:
	json.dump(out, file)