const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');

// Khai báo page ở scope global
let page;

async function downloadVideo(url, filename) {
    console.log(`⬇️ Bắt đầu tải ${filename}...`);
    try {
        // Lấy cookies từ page
        const cookies = await page.cookies();
        const cookieStr = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

        // Lấy headers từ request gốc
        const headers = {
            'Cookie': cookieStr,
            'User-Agent': await page.evaluate(() => navigator.userAgent),
            'Accept': '*/*',
            'Accept-Encoding': 'identity;q=1, *;q=0',  // Yêu cầu không nén để tải trực tiếp
            'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
            'Connection': 'keep-alive',
            'Origin': 'https://drive.google.com',
            'Referer': 'https://drive.google.com/',
            'Sec-Fetch-Dest': filename.includes('video') ? 'video' : 'audio',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site',
            'Range': 'bytes=0-'  // Tải từ đầu đến cuối
        };

        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers: headers,
            maxRedirects: 5,
            timeout: 0, // Không giới hạn timeout
            validateStatus: function (status) {
                return status >= 200 && status < 400;
            }
        });

        // Log thông tin file
        const fileSize = parseInt(response.headers['content-length']);
        console.log(`📦 Kích thước file ${filename}: ${Math.round(fileSize/1024/1024)}MB`);

        // Tạo write stream
        const writer = fs.createWriteStream(filename);
        
        // Log tiến độ tải
        let downloaded = 0;
        response.data.on('data', (chunk) => {
            downloaded += chunk.length;
            const percent = (downloaded * 100) / fileSize;
            process.stdout.write(`\r⏳ ${filename}: ${Math.round(downloaded/1024/1024)}MB / ${Math.round(fileSize/1024/1024)}MB (${percent.toFixed(2)}%)`);
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`\n✅ Đã tải xong ${filename}`);
                resolve();
            });
            writer.on('error', reject);
        });

    } catch (error) {
        console.error(`❌ Lỗi khi tải ${filename}:`, error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response headers:', error.response.headers);
        }
        throw error;
    }
}

async function getVideoUrl() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null
    });
    
    // Gán page vào biến global
    page = await browser.newPage();
    
    try {
        const fileId = '1Oq0sAm62_naz_rMZ4GKP67iVys7pZxIu';
        const videoUrl = `https://drive.google.com/file/d/${fileId}/preview`;
        
        console.log('🚀 Bắt đầu quá trình...');
        console.log('📌 URL video:', videoUrl);
        
        console.log('🌐 Khởi động trình duyệt...');
        const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null
        });
        
        const page = await browser.newPage();
        console.log('📄 Đã tạo trang mới');
        
        let videoStreamUrl = null;
        let audioStreamUrl = null;
        
        // Log tất cả console messages
        page.on('console', msg => console.log('🌐 Browser Console:', msg.text()));
        
        await page.setRequestInterception(true);
        
        page.on('request', request => {
            const url = request.url();
            console.log('📤 Request:', url.substring(0, 100) + '...');
            
            if (url.includes('videoplayback')) {
                try {
                    // Lấy URL gốc không có range
                    const baseUrl = url.split('&range=')[0];
                    
                    // Kiểm tra itag trong URL
                    if (url.includes('itag=136')) {
                        console.log('🎬 Tìm thấy video stream (720p)');
                        videoStreamUrl = baseUrl;
                    } else if (url.includes('itag=134')) {
                        console.log('🎬 Tìm thấy video stream (360p)');
                        if (!videoStreamUrl) videoStreamUrl = baseUrl; // Chỉ lưu nếu chưa có 720p
                    } else if (url.includes('itag=140')) {
                        console.log('🔊 Tìm thấy audio stream');
                        audioStreamUrl = baseUrl;
                    }

                    // Log đầy đủ thông tin về stream
                    if (url.includes('itag=')) {
                        const params = new URLSearchParams(url);
                        console.log('📝 Stream info:', {
                            itag: params.get('itag'),
                            mime: params.get('mime'),
                            quality: params.get('quality'),
                            size: params.get('clen')
                        });
                    }
                } catch (e) {
                    console.error('❌ Lỗi xử lý URL:', e.message);
                }
            }
            request.continue();
        });

        // Log responses
        page.on('response', async response => {
            const url = response.url();
            console.log('📥 Response:', response.status(), '-', url.substring(0, 100) + '...');
        });

        console.log('⏳ Đang truy cập trang video...');
        await page.goto(videoUrl, { 
            waitUntil: 'networkidle0',
            timeout: 60000 
        });
        
        console.log('⏳ Đợi video player load...');
        await new Promise(resolve => setTimeout(resolve, 15000));
        
        // Click vào video để kích hoạt phát
        try {
            await page.click('.drive-viewer-video-player');
            console.log('🖱️ Đã click vào video player');
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (e) {
            console.log('⚠️ Không thể click vào video player:', e.message);
        }
        
        console.log('🔄 Đóng trình duyệt...');
        await browser.close();

        if (videoStreamUrl && audioStreamUrl) {
            console.log('\n✅ Đã tìm thấy URL streams:');
            console.log('🎥 Video:', videoStreamUrl);
            console.log('🔊 Audio:', audioStreamUrl);
            
            console.log('\n⬇️ Bắt đầu tải video và audio...');
            await Promise.all([
                downloadVideo(videoStreamUrl, 'video.mp4'),
                downloadVideo(audioStreamUrl, 'audio.mp4')
            ]);
            
            console.log('\n✅ Hoàn tất! Bạn cần ghép video và audio bằng ffmpeg:');
            console.log('ffmpeg -i video.mp4 -i audio.mp4 -c:v copy -c:a aac output.mp4');
        } else {
            console.log('❌ Không tìm thấy đủ video/audio streams');
            if (videoStreamUrl) console.log('Chỉ tìm thấy video:', videoStreamUrl);
            if (audioStreamUrl) console.log('Chỉ tìm thấy audio:', audioStreamUrl);
        }

        return { videoStreamUrl, audioStreamUrl };

    } catch (error) {
        console.error('❌ Lỗi:', error);
        console.error('Stack trace:', error);
        return false;
    }
}

// Chạy script
console.log('🎬 Bắt đầu chương trình');
getVideoUrl().then(result => {
    if (result) {
        console.log('✅ Kết thúc thành công');
    } else {
        console.log('❌ Kết thúc với lỗi');
    }
}).catch(error => {
    console.error('❌ Lỗi không xử lý được:', error);
});
