function flip_bits(value) {
	return parseInt(value.toString(2).split('').map(bit => 1 - bit).join(''), 2);
}

function sample_value_endian(bytes) {
	const value = (bytes.length == 1) ? bytes[0]
		        : (bytes.length == 2) ? (bytes[1] << 8) + bytes[0]
			    : (bytes.length == 3) ? (bytes[2] << 16) + (bytes[1] << 8) + bytes[0]
				: (bytes.length == 4) ? (bytes[3] << 32) + (bytes[2] << 16) + (bytes[1] << 8) + bytes[0]
				: undefined;

	if (value && bytes[bytes.length - 1] >> 7 == 1) {
		value = -flip_bits(value) - 1;
	}

	return value;
}

function computeCoefficient(signal)
{
	return (signal.physicalMaximum - signal.physicalMinimum) / (signal.digitalMaximum - signal.digitalMinimum);
}

function allocateSignals(count)
{
	let signals = [];
	for (var index = 0; index < count; index++) {
		let signal = new Object();
		signal.records = [];
		signals.push(signal);
	}

	return signals;
}

function extractSignalSamplesInRange(signal, range)
{
	let records = signal.records.slice(range.from, range.until);
	let samples = [];

	records.forEach((record) => samples.push(...record));

	return samples;
}

class EDFParser {
	constructor(uint8array) {
		this.array = uint8array
		this.byteOffset = 0
	}

	readBytes(length) {
		if (this.byteOffset + length > this.array.byteLength)
		{
			return null;
		}

		const value = this.array.slice(this.byteOffset, this.byteOffset + length);
		this.byteOffset += length;
		return value;
	}

	readText(length) {
		const data = this.readBytes(length);

		if (!data) {
			return null;
		}

		const decoder = new TextDecoder();
		let value = decoder.decode(data);
		value = value?.trim();

		return value;
	}

	readInt16(length = 8) {
		const text = this.readText(length);
		return parseInt(text);
	}

	readInt8(length = 4) {
		const text = this.readText(length);
		return parseInt(text);
	}

	readFloat32(length = 8) {
		const text = this.readText(length);
		return parseFloat(text);
	}

	readSampleValue(bitsSize) {
		const useLittleEndian = true;
		const data_view = new DataView(this.array.buffer, this.byteOffset, this.array.byteLength - this.byteOffset);

		let value = undefined;

		switch(bitsSize) {
			case 8:
				value = data_view.getInt8(0, useLittleEndian);
				break;

			case 16:
				value = data_view.getInt16(0, useLittleEndian);
				break;

			case 24:
				value = data_view.getInt16(0, useLittleEndian);
				value << 8;
				value += data_view.getInt8(2, useLittleEndian);
				break;
		}

		this.byteOffset += (bitsSize / 8);
		return value
	}
}

class EDF {
	constructor(uint8array) {
		const parser = new EDFParser(uint8array);

		this.version = parser.readText(8);
		this.patient = parser.readText(80);
		this.recordingIdentification = parser.readText(80);
		this.recordingStartDate = parser.readText(8);
		this.recordingStartTime = parser.readText(8);
		this.headerBytesSize = parser.readText(8);
		this.reserved = parser.readText(44); // EDF is 32 whereas EDF++ is 44.

		this.dataRecordsCount = parser.readInt16();
		this.dataRecordDuration = parser.readInt16();
		this.recordingDuration = this.dataRecordDuration * this.dataRecordsCount;

		const signalsCount = parser.readInt8();

		this.signals = allocateSignals(signalsCount);
		this.signals.forEach((signal) => signal.label = parser.readText(16) );
		this.signals.forEach((signal) => signal.transducer = parser.readText(80) );
		this.signals.forEach((signal) => signal.dimensions = parser.readText(8) );
		this.signals.forEach((signal) => signal.physicalMinimum = parser.readInt16() );
		this.signals.forEach((signal) => signal.physicalMaximum = parser.readInt16() );
		this.signals.forEach((signal) => signal.digitalMinimum = parser.readInt16() );
		this.signals.forEach((signal) => signal.digitalMaximum = parser.readInt16() );
		this.signals.forEach((signal) => signal.preFilters = parser.readText(80) );
		this.signals.forEach((signal) => signal.samplesCountPerRecord = parser.readInt16() );
		this.signals.forEach((signal) => signal.reserved = parser.readBytes(32) );

		this.signals.forEach((signal) => signal.coefficient = computeCoefficient(signal) );

		this.hasAnnotations = false;
		let annotationsCount = 0;

		this.signals.forEach((signal) => {
			signal.hasAnnotations = (signal.label.indexOf("DF Annotations") > 0);

			if (signal.hasAnnotations) {
				annotationsCount++;
				this.hasAnnotations = true;
			}
		});

		this.annotationBytesSize = 0;

		if (this.hasAnnotations) {
			this.samplingsCount += 60 * 2;

			this.signals.forEach((signal) => {
				if (signal.hasAnnotations) {
					this.annotationBytesSize += signal.samplesCountPerRecord * 2;
				}
			});
		}

		const sampleValueInBits = this.version == "0" ? 16 : 24;

		for (var recordIndex = 0; recordIndex < this.dataRecordsCount; recordIndex++) {
			this.signals.forEach((signal) => {
				if (signal.hasAnnotations) {
					const annotation = parser.readText(this.annotationBytesSize);
					console.log("Annotation: ", annotation)
				} else {
					let samples = [];
					for (var sampleIndex = 0; sampleIndex < signal.samplesCountPerRecord; sampleIndex++) {
						const value = parser.readSampleValue(sampleValueInBits);
						samples.push(value * signal.coefficient);
					}
					signal.records.push(samples);
				}
			});
		}

		let samplesCountPerRecordMaximum = 0;
		this.signals.forEach((signal) => samplesCountPerRecordMaximum = Math.max(samplesCountPerRecordMaximum, signal.samplesCountPerRecord));
		this.samplingRate = this.recordingDuration / samplesCountPerRecordMaximum;
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
			if (!signal.hasAnnotations) {
				signalsSamples.push(extractSignalSamplesInRange(signal, range));
			}
		});

		return signalsSamples;
	}
}
