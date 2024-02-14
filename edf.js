function computeSignalScale(signal) {
	return (signal.physicalMaximum - signal.physicalMinimum) / (signal.digitalMaximum - signal.digitalMinimum);
}

function allocateSignals(count) {
	const signals = [];

	for (var index = 0; index < count; index++) {
		const signal = {};
		signal.annotations = [];
		signal.records = [];
		signals.push(signal);
	}

	return signals;
}

function makeAllocation() {
	const annotation = {};
	annotation.onset = 0.0;
	annotation.duration = 0.0;
	annotation.notes = [];

	return annotation;
}

function extractSignalSamplesInRange(signal, range) {
	let records = signal.records.slice(range.from, range.until);
	let samples = [];

	records.forEach((record) => samples.push(...record));

	return samples;
}

class EDFParser {
	constructor(arrayBuffer) {
		this.arrayBuffer = arrayBuffer;
		this.byteOffset = 0;
		this.byteLength = this.arrayBuffer.byteLength;
		this.byteRemaining = this.byteLength;
		this.data_view = new DataView(this.arrayBuffer);
		this.decoder = new TextDecoder();
		this.useLittleEndian = true;
	}

	advance(length) {
		const byteCount = Math.min(length, this.byteRemaining);
		this.byteRemaining -= byteCount;
		this.byteOffset += byteCount;
	}

	checkRead(length) {
		return (length <= this.byteRemaining);
	}

	readBytes(length) {
		if (!this.checkRead(length)) {
			return null;
		}

		const value = this.arrayBuffer.slice(this.byteOffset, this.byteOffset + length);
		this.advance(length);
		return value;
	}

	readText(length) {
		const text = this.decoder.decode(this.readBytes(length));

		return text?.trim();
	}

	readTextAsInt16(length = 8) {
		return parseInt(this.readText(length));
	}

	readTextAsInt8(length = 4) {
		return parseInt(this.readText(length));
	}

	readTextAsFloat32(length = 8) {
		return parseFloat(this.readText(length));
	}

	readInt8() {
		const length = 1;

		if (!this.checkRead(length)) {
			return null;
		}

		const value = this.data_view.getInt8(this.byteOffset);
		this.advance(length);
		return value;
	}

	readInt16() {
		const length = 2;

		if (!this.checkRead(length)) {
			return null;
		}

		const value = this.data_view.getInt16(this.byteOffset, this.useLittleEndian);
		this.advance(length);
		return value;
	}

	readInt24() {
		const length = 3;

		if (!this.checkRead(length)) {
			return null;
		}

		let value = this.readInt16();
		value << 8;
		value += this.readInt8();
		return value;
	}

	readAnnotations(length) {
		const MARKER_END_ANNOTATION = 0;
		const MARKER_END_BLOCK = 20;
		const MARKER_END_BLOCK_ONSET = 21;

		const MODE_ONSET = 0;
		const MODE_DURATION = 1;
		const MODE_NOTES = 2;
		const MODE_ANNOTATION_DONE = 3;

		const data = new Uint8Array(this.readBytes(length));

		const annotations = [];

		let mode = MODE_ONSET;
		let beginOffset = 0;
		let annotation = null;
		let decoder = this.decoder;

		//
		// Callback that is invoked at the end of each block is encountered.
		//
		function onEndBlock(dataOffset, setter)
		{
			const text = decoder.decode(data.slice(beginOffset, dataOffset))?.trim();

			if (text) {
				setter(text);
			}

			beginOffset = dataOffset + 1;
		}

		for (let dataOffset = 0; dataOffset < data.byteLength; dataOffset++) {

			const currentByte = data[dataOffset];

			if (currentByte === MARKER_END_ANNOTATION) {
				if (mode === MODE_ANNOTATION_DONE) { // Exit loop when processing two consecutive end annotations (null character)
					break;
				}
				mode = MODE_ANNOTATION_DONE;
			} else if (mode === MODE_ANNOTATION_DONE) {
				mode = MODE_ONSET;
			}

			switch (mode) {
				case MODE_ONSET:
					{
						if (currentByte === MARKER_END_BLOCK || currentByte === MARKER_END_BLOCK_ONSET) {
							annotation = makeAllocation();
							onEndBlock(dataOffset, text => annotation.onset = parseFloat(text));
							mode = (currentByte === MARKER_END_BLOCK_ONSET) ? MODE_DURATION : MODE_NOTES;
						}
					}
					break;

				case MODE_DURATION:
					{
						if (currentByte === MARKER_END_BLOCK) {
							onEndBlock(dataOffset, text => annotation.duration = parseFloat(text));
							mode = MODE_NOTES;
						}
					}
					break;

				case MODE_NOTES:
					{
						if (currentByte === MARKER_END_BLOCK) {
							onEndBlock(dataOffset, text => annotation.notes.push(text));
						}
					}
					break;

				case MODE_ANNOTATION_DONE:
					{
						if (annotation) {
							annotations.push(annotation);
							annotation = null;
						}
						beginOffset = dataOffset + 1;
					}
					break;
			}
		}

		return annotations;
	}
}

class EDF {
	constructor(uint8array) {
		const parser = new EDFParser(uint8array.buffer);

		this.version = parser.readText(8);
		this.patient = parser.readText(80);
		this.recordingIdentification = parser.readText(80);
		this.recordingStartDate = parser.readText(8);
		this.recordingStartTime = parser.readText(8);
		this.headerBytesSize = parser.readText(8);
		this.reserved = parser.readText(44);

		this.dataRecordsCount = parser.readTextAsInt16();
		this.dataRecordDuration = parser.readTextAsFloat32();
		this.recordingDuration = this.dataRecordDuration * this.dataRecordsCount;
		this.samplesBytesSize = 2;

		const signalsCount = parser.readTextAsInt8();

		const signals = allocateSignals(signalsCount);
		signals.forEach(signal => signal.label = parser.readText(16));
		signals.forEach(signal => signal.transducer = parser.readText(80));
		signals.forEach(signal => signal.dimensions = parser.readText(8));
		signals.forEach(signal => signal.physicalMinimum = parser.readTextAsInt16());
		signals.forEach(signal => signal.physicalMaximum = parser.readTextAsInt16());
		signals.forEach(signal => signal.digitalMinimum = parser.readTextAsInt16());
		signals.forEach(signal => signal.digitalMaximum = parser.readTextAsInt16());
		signals.forEach(signal => signal.preFilters = parser.readText(80));
		signals.forEach(signal => signal.samplesCountPerRecord = parser.readTextAsInt16());
		signals.forEach(signal => signal.reserved = parser.readBytes(32));

		signals.forEach(signal => signal.hasAnnotations = (signal.label.indexOf("DF Annotations") > 0));
		signals.forEach(signal => signal.scale = computeSignalScale(signal));

		let readSampleValue = parser => parser.readInt16();

		if (this.samplesBytesSize === 3) {
			readSampleValue = parser => parser.readInt24();
		}

		for (var recordIndex = 0; recordIndex < this.dataRecordsCount; recordIndex++) {
			signals.forEach(signal => {
				if (signal.hasAnnotations) {
					const annotations = parser.readAnnotations(signal.samplesCountPerRecord * this.samplesBytesSize);
					signal.annotations.push(...annotations);
				} else {
					let samples = [];
					for (var sampleIndex = 0; sampleIndex < signal.samplesCountPerRecord; sampleIndex++) {
						samples.push(readSampleValue(parser) * signal.scale);
					}
					signal.records.push(samples);
				}
			});
		}

		this.annotations = signals.filter(signal => signal.hasAnnotations);
		this.signals = signals.filter(signal => !signal.hasAnnotations);

		let samplesCountPerRecordMaximum = 0;
		this.signals.forEach(signal => samplesCountPerRecordMaximum = Math.max(samplesCountPerRecordMaximum, signal.samplesCountPerRecord));
		this.samplingRate = samplesCountPerRecordMaximum / this.dataRecordDuration;
	}

	computeSamplesRange(timeOffset, duration) {
		const startRecordsOffset = Math.floor(timeOffset / this.dataRecordDuration);
		const recordsCount = Math.ceil(duration / this.dataRecordDuration);
		const finishRecordsOffset = startRecordsOffset + recordsCount;

		const range = {};
		range.from = Math.min(startRecordsOffset, this.dataRecordsCount);
		range.until = Math.min(finishRecordsOffset, this.dataRecordsCount);

		return range;
	}

	getSignalSamplesInRange(signalsIndex, timeOffset, duration) {
		const range = this.computeSamplesRange(timeOffset, duration);

		return extractSignalSamplesInRange(this.signals[signalsIndex], range);
	}

	getAllSignalsSamplesInRange(timeOffset, duration) {
		const range = this.computeSamplesRange(timeOffset, duration);

		let signalsSamples = [];

		this.signals.forEach((signal) => {
			signalsSamples.push(extractSignalSamplesInRange(signal, range));
		});

		return signalsSamples;
	}
}
