# jsEDF
JavaScript reader of EDF+/BDF+ files

**Usage**
```js
var bytes = UInt8Array(); //Acquired some how (e.g. from input-file or server-based)

var edf = new EDF(bytes);

console.log("DateTime:", edf.recordingStartDate, edf.recordingStartTime);
console.log("Duration:", edf.recordingDuration, "seconds");
console.log("Has annotations:", edf.hasAnnotations);
console.log("Signals count:", edf.signals.length);

edf.signals.forEach((signal, index) => console.log("> ", index, edf.channels[i].label));

var startSecond = 1;
var lengthSeconds = 5;

//Reading data from all channels [[], [], []]
var data = edf.getAllSignalsSamplesInRange(startSecond, lengthSeconds);

var channelIndex = 1;
//Reading data from one channel
var singleChannelData = edf.getSignalSamplesInRange(channelIndex, startSecond, lengthSeconds);
```

**Demo**

https://neurobotics.ru/nt/edf/

or just open *demo.html* from this repo
