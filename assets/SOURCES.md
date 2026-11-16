# Ambience beds: sources and licenses

Built by `projects/live3_interaction/demo/offline/ambience_beds.py` (seeded, reproducible; the recordings are
downloaded once from the preview URLs below). Only CC0 recordings and synthesized sound are used; the builder
refuses a freesound sound whose page does not carry the CC0 1.0 deed
(https://creativecommons.org/publicdomain/zero/1.0/). Voices are low-passed and layered into murmur (no
recognizable words: checked with Fish batch ASR, see demo/AMBIENCE.md).

## Files

| file | loop | content |
|---|---|---|
| line.mp3 | 47 s | telephone line: band-limited hiss (300-3400 Hz), faint 60 Hz hum, slow drift |
| retail.mp3 | 64 s | call-centre room: ventilation room tone, murmur of other agents, distant keyboards |
| drive_thru.mp3 | 72 s | fast-food kitchen behind the crew headset: low hood hum, occasional fryer sizzle, basket clacks, register and timer beeps, crew murmur; idling car and traffic at the speaker post |
| flights.mp3 | 60 s | quiet office: room tone, occasional distant murmur and typing |

Synthesized (numpy, no source audio): the whole of `line.mp3`; in `drive_thru.mp3` the fryer-timer, grill-timer and register beeps; every reverb tail.

## Recordings (freesound.org, CC0 1.0)

| id | author | title | license | preview downloaded | used in |
|---|---|---|---|---|---|
| [162662](https://freesound.org/people/cognito%20perceptu/sounds/162662/) | cognito perceptu | restaurant kitchen.wav | CC0 1.0 | https://cdn.freesound.org/previews/162/162662_57789-hq.mp3 | drive_thru.mp3 |
| [346861](https://freesound.org/people/ptp8ss/sounds/346861/) | ptp8ss | Car Idling | CC0 1.0 | https://cdn.freesound.org/previews/346/346861_3979251-hq.mp3 | drive_thru.mp3 |
| [347309](https://freesound.org/people/cpark12/sounds/347309/) | cpark12 | RESTAURANT KITCHEN IS BUSY.wav | CC0 1.0 | https://cdn.freesound.org/previews/347/347309_4029822-hq.mp3 | drive_thru.mp3 |
| [399823](https://freesound.org/people/BonnyOrbit/sounds/399823/) | BonnyOrbit | Keyboard typing in office.WAV | CC0 1.0 | https://cdn.freesound.org/previews/399/399823_5902878-hq.mp3 | retail.mp3, flights.mp3 |
| [455653](https://freesound.org/people/Audeption/sounds/455653/) | Audeption | deep-fryer_sizzle.wav | CC0 1.0 | https://cdn.freesound.org/previews/455/455653_8323418-hq.mp3 | drive_thru.mp3 |
| [579568](https://freesound.org/people/leonelmail/sounds/579568/) | leonelmail | Office ambience - call center 3 | CC0 1.0 | https://cdn.freesound.org/previews/579/579568_4437257-hq.mp3 | retail.mp3, flights.mp3 |
| [587177](https://freesound.org/people/Urkki69/sounds/587177/) | Urkki69 | Sizzling Steaks on a Gas Grill | CC0 1.0 | https://cdn.freesound.org/previews/587/587177_12244617-hq.mp3 | drive_thru.mp3 |
| [637625](https://freesound.org/people/kyles/sounds/637625/) | kyles | kitchen restaurant fries deep fryer basket pickup put down clack metal.flac | CC0 1.0 | https://cdn.freesound.org/previews/637/637625_612689-hq.mp3 | drive_thru.mp3 |
| [637804](https://freesound.org/people/kyles/sounds/637804/) | kyles | room tone office hallway heavy ventilation.flac | CC0 1.0 | https://cdn.freesound.org/previews/637/637804_612689-hq.mp3 | retail.mp3 |
| [637857](https://freesound.org/people/kyles/sounds/637857/) | kyles | street light distant traffic and couple of cars pass Verdun, Montreal, Canada.flac | CC0 1.0 | https://cdn.freesound.org/previews/637/637857_612689-hq.mp3 | drive_thru.mp3 |
| [710651](https://freesound.org/people/felix.blume/sounds/710651/) | felix.blume | Restaurant interior with air conditioning blowing, kitchen hubbub, voices, cutlery | CC0 1.0 | https://cdn.freesound.org/previews/710/710651_1661766-hq.mp3 | drive_thru.mp3 |
| [752611](https://freesound.org/people/joseegn/sounds/752611/) | joseegn | Office_Ambience_Interior_quiet | CC0 1.0 | https://cdn.freesound.org/previews/752/752611_3574619-hq.mp3 | flights.mp3 |
