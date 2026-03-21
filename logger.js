const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { Writable } = require('stream');

const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const getLogFilePath = () => {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return path.join(logDir, `app_${day}_${month}_${year}.log`);
};

const formatSpanish = (date) => {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
};

function createDailyFileStream() {
    let currentStream = null;
    let currentDay = null;

    return new Writable({
        write(chunk, encoding, callback) {
            const today = new Date().toDateString();
            if (today !== currentDay) {
                if (currentStream) currentStream.end();
                currentStream = fs.createWriteStream(getLogFilePath(), { flags: 'a' });
                currentDay = today;
            }
            currentStream.write(chunk, encoding, callback);
        },
        final(callback) {
            if (currentStream) currentStream.end(callback);
            else callback();
        }
    });
}

const prettyFactory = require('pino-pretty').prettyFactory;
const prettyOpts = {
    colorize: true,
    translateTime: false,
    ignore: 'pid,hostname'
};
const pretty = prettyFactory(prettyOpts);

const fileStream = createDailyFileStream();

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    timestamp: () => `,"time":"${formatSpanish(new Date())}"`,
}, fileStream);

const origInfo = logger.info.bind(logger);
const origError = logger.error.bind(logger);
const origWarn = logger.warn.bind(logger);
const origDebug = logger.debug.bind(logger);

logger.info = (msg, ...args) => {
    origInfo(msg, ...args);
    process.stdout.write(pretty(JSON.stringify({ level: 30, msg })) + '\n');
};

logger.error = (msg, ...args) => {
    origError(msg, ...args);
    process.stdout.write(pretty(JSON.stringify({ level: 50, msg })) + '\n');
};

logger.warn = (msg, ...args) => {
    origWarn(msg, ...args);
    process.stdout.write(pretty(JSON.stringify({ level: 40, msg })) + '\n');
};

logger.debug = (msg, ...args) => {
    origDebug(msg, ...args);
    process.stdout.write(pretty(JSON.stringify({ level: 20, msg })) + '\n');
};

module.exports = logger;
