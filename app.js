const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Cấu hình
const OUTPUT_DIR = 'C:\\NEXT\\video';
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB mỗi chunk
const MAX_CONCURRENT_CHUNKS = 16; // 16 luồng
const RETRY_TIMES = 3;
const RETRY_DELAY = 1000;

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

                // Xóa files tạm
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

// Thêm vào trước phần gọi hàm
async function getVideoUrl() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null
    });
    
    page = await browser.newPage();
    
    try {
        const fileId = '1yLT3ce__JtXLeQv9A9uG5KgY9Vx-YGwJ';
        const videoUrl = `https://drive.google.com/file/d/${fileId}/preview`;
        
        console.log('🚀 Bắt đầu quá trình...');
        console.log('📌 URL video:', videoUrl);

        let videoStream = null;
        let audioStream = null;
        let downloadComplete = false;
        
        await page.setRequestInterception(true);
        
        page.on('request', async request => {
            const url = request.url();
            
            if (url.includes('videoplayback')) {
                try {
                    const baseUrl = url.split('&range=')[0];
                    const params = new URLSearchParams(url);
                    const itag = params.get('itag');
                    
                    if (itag === '136' && !videoStream) {
                        videoStream = baseUrl;
                    } else if (itag === '140' && !audioStream) {
                        audioStream = baseUrl;
                    }

                    if (videoStream && audioStream && !isDownloading) {
                        isDownloading = true;
                        try {
                            await Promise.all([
                                downloadVideo(videoStream, 'temp_video.mp4'),
                                downloadVideo(audioStream, 'temp_audio.mp4')
                            ]);
                            
                            await mergeVideoAudio();
                            downloadComplete = true;
                            await browser.close();
                            process.exit(0);
                        } catch (error) {
                            console.error('❌ Lỗi:', error.message);
                            await browser.close();
                            process.exit(1);
                        }
                    }
                } catch (e) {
                    console.error('❌ Lỗi:', e.message);
                }
            }
            request.continue();
        });

        await page.goto(videoUrl, {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        // Click để kích hoạt player
        try {
            const frame = await page.waitForSelector('iframe[src*="drive.google.com"]');
            const contentFrame = await frame.contentFrame();
            await contentFrame.waitForSelector('video');
            await contentFrame.click('video');
        } catch (e) {
            console.log('⚠️ Không thể click vào video, nhưng vẫn tiếp tục...');
        }

        // Chờ cho đến khi tải xong
        while (!downloadComplete) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!videoStream || !audioStream) {
                console.log('⏳ Đang đợi stream...');
            }
        }

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
