import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';

function localTime(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return `[${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}] `;
}

const TIMESTAMP_PREFIX = /^\[\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /;

function timestampStream(stream) {
  const originalWrite = stream.write.bind(stream);
  const decoder = new StringDecoder('utf8');
  let lineStart = true;
  stream.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    let output = '';
    for (const line of text.split(/(?<=\n)/)) {
      if (!line) continue;
      if (lineStart && line !== '\n' && !TIMESTAMP_PREFIX.test(line)) output += localTime(new Date());
      output += line;
      lineStart = line.endsWith('\n');
    }
    return originalWrite(output, typeof encoding === 'function' ? encoding : callback);
  };
}

export function installTerminalTimestamps() {
  timestampStream(process.stdout);
  timestampStream(process.stderr);
}
