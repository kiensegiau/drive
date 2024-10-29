const puppeteer = require('puppeteer');
const util = require('util');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');

// Cấu hình
const OUTPUT_DIR = 'C:\\NEXT\\video';
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB mỗi chunk
const MAX_CONCURRENT_CHUNKS = 16; // 16 luồng
const RETRY_TIMES = 3;
const RETRY_DELAY = 1000;

const VIDEO_ITAGS = {
    '137': '1080p',
    '136': '720p',
    '135': '480p', 
    '134': '360p',
    '133': '240p',
    '160': '144p'
};

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function formatTime(seconds) {
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

async function downloadChunk(url, start, end, headers) {
    const rangeHeaders = {
        ...headers,
        'Range': `bytes=${start}-${end}`
    };

    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        headers: rangeHeaders,
        timeout: 30000
    });

    return response.data;
}

async function downloadVideo(url, filename) {
    const outputPath = path.join(OUTPUT_DIR, filename);
    console.log(`\n⬇️ Bắt đầu tải ${filename}...`);

    try {
        const cookies = await page.cookies();
        const cookieStr = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

        const headers = {
            'Cookie': cookieStr,
            'User-Agent': await page.evaluate(() => navigator.userAgent),
            'Accept': '*/*',
            'Accept-Encoding': 'identity;q=1, *;q=0',
            'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
            'Connection': 'keep-alive'
        };

        // Lấy kích thước file
        const response = await axios.head(url, { headers });
        const fileSize = parseInt(response.headers['content-length']);
        console.log(`📦 Kích thước file ${filename}: ${Math.round(fileSize/1024/1024)}MB`);

        // Tính số chunks
        const chunks = Math.ceil(fileSize / CHUNK_SIZE);
        const chunkInfos = [];
        let downloadedChunks = 0;
        let startTime = Date.now();
        let lastUpdate = Date.now();
        let lastBytes = 0;

        for (let i = 0; i < chunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
            chunkInfos.push({ index: i, start, end });
        }

        // Tạo file trống
        const writer = fs.createWriteStream(outputPath);
        writer.write(Buffer.alloc(fileSize));
        writer.end();

        await new Promise(resolve => writer.on('finish', resolve));

        // Tải chunks
        const fd = fs.openSync(outputPath, 'r+');
        console.log(`🚀 Tải với ${MAX_CONCURRENT_CHUNKS} luồng...`);

        for (let i = 0; i < chunks; i += MAX_CONCURRENT_CHUNKS) {
            const batch = chunkInfos.slice(i, i + MAX_CONCURRENT_CHUNKS);
            await Promise.all(batch.map(async ({ index, start, end }) => {
                try {
                    const chunkData = await downloadChunk(url, start, end, headers);
                    fs.writeSync(fd, chunkData, 0, chunkData.length, start);
                    downloadedChunks++;

                    const downloadedBytes = downloadedChunks * CHUNK_SIZE;
                    const progress = (downloadedChunks / chunks) * 100;
                    const currentTime = Date.now();

                    if (currentTime - lastUpdate >= 1000) {
                        const speed = ((downloadedBytes - lastBytes) / 1024 / 1024) / ((currentTime - lastUpdate) / 1000);
                        const elapsed = (currentTime - startTime) / 1000;
                        const remaining = elapsed / (progress / 100) - elapsed;

                        process.stdout.write(
                            `\r⏳ ${filename}: ${Math.round(downloadedBytes/1024/1024)}MB / ${Math.round(fileSize/1024/1024)}MB ` +
                            `(${progress.toFixed(2)}%) - ${speed.toFixed(2)} MB/s - Còn lại: ${formatTime(remaining)}`
                        );

                        lastUpdate = currentTime;
                        lastBytes = downloadedBytes;
                    }
                } catch (error) {
                    console.error(`\n❌ Lỗi tải chunk ${index}:`, error.message);
                    throw error;
                }
            }));
        }

        fs.closeSync(fd);
        console.log(`\n✅ Hoàn thành tải ${filename}`);

    } catch (error) {
        console.error(`\n❌ Lỗi khi tải ${filename}:`, error.message);
        throw error;
    }
}

async function mergeVideoAudio() {
    const videoPath = path.join(OUTPUT_DIR, 'temp_video.mp4');
    const audioPath = path.join(OUTPUT_DIR, 'temp_audio.mp4');
    const outputPath = path.join(OUTPUT_DIR, 'final_video.mp4');
    const progressPath = path.join(OUTPUT_DIR, 'ffmpeg-progress.txt');

    return new Promise((resolve, reject) => {
        console.log('\n🔄 Đang ghép video và audio...');
        let mergeStartTime = Date.now();

        // Tạo file progress tạm
        fs.writeFileSync(progressPath, '');
        
        const ffmpeg = exec(
            `ffmpeg -y -i "${videoPath}" -i "${audioPath}" ` +
            `-c:v copy -c:a aac ` +
            `-progress "${progressPath}" ` +
            `"${outputPath}"`,
            { maxBuffer: 1024 * 1024 * 10 }
        );

        let duration = 0;
        let progressInterval;

        // Đọc file progress
        progressInterval = setInterval(() => {
            try {
                const progress = fs.readFileSync(progressPath, 'utf8');
                
                // Lấy duration
                if (!duration) {
                    const durationMatch = progress.match(/Duration: (\d{2}):(\d{2}):(\d{2})/);
                    if (durationMatch) {
                        const [_, hours, minutes, seconds] = durationMatch;
                        duration = (parseInt(hours) * 3600) + (parseInt(minutes) * 60) + parseInt(seconds);
                    }
                }

                // Lấy tiến trình
                const timeMatch = progress.match(/out_time_ms=(\d+)/);
                if (timeMatch && duration) {
                    const currentMs = parseInt(timeMatch[1]) / 1000000; // convert microseconds to seconds
                    const percent = (currentMs / duration) * 100;
                    const elapsedSeconds = (Date.now() - mergeStartTime) / 1000;
                    const speed = currentMs / elapsedSeconds;
                    const eta = (duration - currentMs) / speed;

                    process.stdout.write(
                        `\r🔄 Ghép video: ${percent.toFixed(1)}% - ` +
                        `Tốc độ: ${speed.toFixed(1)}x - ` +
                        `Còn lại: ${formatTime(eta)}`
                    );
                }
            } catch (err) {
                // Bỏ qua lỗi đọc file
            }
        }, 500);

        ffmpeg.on('close', (code) => {
            clearInterval(progressInterval);
            
            // Xóa file progress
            try {
                fs.unlinkSync(progressPath);
            } catch (err) {}

            if (code === 0) {
                const totalTime = (Date.now() - mergeStartTime) / 1000;
                console.log(`\n✅ Hoàn thành ghép video! (${totalTime.toFixed(1)}s)`);
                
                const finalSize = fs.statSync(outputPath).size;
                console.log(`📦 File cuối: ${(finalSize/1024/1024).toFixed(1)}MB`);

                // Xóa files tm
                fs.unlinkSync(videoPath);
                fs.unlinkSync(audioPath);
                resolve();
            } else {
                reject(new Error('Lỗi khi ghép video'));
            }
        });

        ffmpeg.on('error', (error) => {
            clearInterval(progressInterval);
            console.error('❌ Lỗi FFmpeg:', error.message);
            reject(error);
        });
    });
}

const userDataDir = path.join(__dirname, 'chrome-data'); // Thư mục lưu profile

async function getVideoUrl() {
    try {
        console.log('🚀 Khởi động trình duyệt...');
        const browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--flag-switches-begin',
                '--flag-switches-end',
                `--window-size=1920,1080`,
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ],
            defaultViewport: {
                width: 1920,
                height: 1080
            },
            userDataDir: userDataDir,
            ignoreDefaultArgs: ['--enable-automation']
        });
        
        page = await browser.newPage();

        // Truy cập URL video Drive
        const videoUrl = 'https://drive.google.com/file/d/1MW8mOl7iyQQyhYWg7y2_HIUwplgMlsXw/view?usp=drive_link';
        console.log('🌐 Đang truy cập video...');
        
        await page.goto(videoUrl, {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        console.log('⏳ Đang đợi video load...');
        const previewFrame = await page.waitForSelector('iframe[src*="drive.google.com"]');
        const contentFrame = await previewFrame.contentFrame();

        // Tìm URL trực tiếp từ source
        const videoData = await contentFrame.evaluate(() => {
            const ytPlayer = document.querySelector('#movie_player');
            if (ytPlayer && ytPlayer.getAvailableQualityLevels) {
                const qualities = ytPlayer.getAvailableQualityLevels();
                const config = ytPlayer.getPlayerResponse();
                return {
                    qualities: qualities,
                    streamingData: config.streamingData
                };
            }
            return null;
        });

        if (videoData && videoData.streamingData) {
            const { formats, adaptiveFormats } = videoData.streamingData;
            
            // Tìm video stream chất lượng cao nhất
            let bestVideoStream = null;
            let audioStream = null;

            for (const format of adaptiveFormats) {
                if (format.mimeType.includes('video/mp4')) {
                    if (!bestVideoStream || format.height > bestVideoStream.height) {
                        bestVideoStream = format;
                    }
                } else if (format.mimeType.includes('audio/mp4') && !audioStream) {
                    audioStream = format;
                }
            }

            if (bestVideoStream && audioStream) {
                console.log(`🎥 Đã tìm thấy video stream (${bestVideoStream.height}p)`);
                console.log(`🔊 Đã tìm thấy audio stream`);

                console.log(`\n📺 Tải video với độ phân giải ${bestVideoStream.height}p`);
                await downloadVideo(bestVideoStream.url, 'temp_video.mp4');
                await downloadVideo(audioStream.url, 'temp_audio.mp4');
                await mergeVideoAudio();
                return;
            }
        }

        // Nếu không tìm được URL trực tiếp, fallback về cách cũ
        console.log('⚠️ Không tìm được URL trực tiếp, thử phương pháp khác...');
        // ... code cũ ...

    } catch (error) {
        console.error('❌ Lỗi:', error.message);
        await browser.close();
        return false;
    }
}

// Phần code getVideoUrl() giữ nguyên
let isDownloading = false;
let page;

console.log('🎬 Bắt đầu chương trình');
getVideoUrl().catch(error => {
    console.error(' Lỗi không xử lý được:', error);
});
