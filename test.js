const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { PNG } = require('pngjs');

const CHATGPT_URL = "https://chat.openai.com/g/g-6844c510f02c819189891d4df738e89d-char-move-ai";
const QA_URL = "https://chat.openai.com/g/g-684f7cae88508191bc5114ae239b033b-qa-move-char";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomSleep(min = 2000, max = 15000) {
  const args = process.argv.slice(2);
  const debugMode = args.includes("-debug");
  if (!debugMode) return Promise.resolve();
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  const seconds = (ms / 1000).toFixed(2);
  console.log(`⏳ Debug sleep: Waiting ${seconds} seconds...`);
  return sleep(ms);
}

function isPngComplete(filePath) {
  const data = fs.readFileSync(filePath);
  const eof = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
  return data.slice(-8).equals(eof);
}

function hasTransparentBackground(filePath) {
  const buffer = fs.readFileSync(filePath);
  const png = PNG.sync.read(buffer);
  let transparentPixels = 0;
  let totalPixels = png.width * png.height;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] < 255) transparentPixels++;
  }
  return transparentPixels / totalPixels > 0.1;
}

async function downloadImage(imageUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(imageUrl, response => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function generateMovesheet(browser, imagePath, attempt) {
  const page = await browser.newPage();
  await randomSleep();
  await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.ProseMirror', { timeout: 60000 });
  await randomSleep();

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) throw new Error("Cannot find file input.");
  await fileInput.uploadFile(path.resolve(imagePath));

  let basePrompt = `Generate a movesheet of this character based on this reference.`;
  let previousUrls = new Set();
  let attemptLocal = 0;

  while (attemptLocal < 2) {
    await page.type('.ProseMirror', basePrompt);
    await sleep(5000);
    await randomSleep();
    await page.keyboard.press('Enter');

    const timeoutMs = 180000;
    const start = Date.now();
    let imageUrl = null;

    while (Date.now() - start < timeoutMs) {
      await randomSleep();
      const imageHandles = await page.$$('img[alt="Image générée"]');
      for (let handle of imageHandles.reverse()) {
        const src = await handle.evaluate(img => img.src);
        if (src && !previousUrls.has(src)) {
          imageUrl = src;
          previousUrls.add(src);
          break;
        }
      }

      if (imageUrl) {
        const tmpPath = 'tmp-output.png';
        await downloadImage(imageUrl, tmpPath);
        const complete = isPngComplete(tmpPath);
        if (complete) {
          const validAlpha = hasTransparentBackground(tmpPath);
          if (validAlpha) {
            fs.renameSync(tmpPath, 'output.png');
            console.log("✅ Image downloaded with transparent background.");
            await page.close();
            return 'output.png';
          } else {
            console.log("⚠️ Image has no transparency.");
            const failDir = path.join(__dirname, 'FAIL');
            if (!fs.existsSync(failDir)) fs.mkdirSync(failDir);
            const failName = `fail_transparency_${attempt + 1}.png`;
            fs.renameSync(tmpPath, path.join(failDir, failName));
            await page.close();
            return null;
          }
        }
      }
      await sleep(10000);
    }

    basePrompt = `Generate the exact same image again, but ensure the background is fully transparent using true alpha channel.`;
    attemptLocal++;
    await randomSleep();
  }

  await page.close();
  throw new Error("⛔ No valid PNG with transparency generated after all attempts.");
}

async function validateWithSecondGPT(page, outputPath, attempt) {
  await randomSleep();
  await page.goto(QA_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.ProseMirror', { timeout: 60000 });
  await randomSleep();

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) throw new Error("❌ Cannot find QA file input.");
  await fileInput.uploadFile(path.resolve(outputPath));
  await sleep(5000);
  await randomSleep();

  await page.type('.ProseMirror', 'Please validate this movesheet.');
  await page.keyboard.press('Enter');
  console.log("✅ Image sent for validation.");

  const timeoutMs = 180000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await randomSleep();
    const content = await page.evaluate(() => {
      const block = document.querySelector('div.markdown.prose');
      return block ? block.innerText : '';
    });

    if (content.includes("RESULT: PASS")) {
      console.log("✅ Validation confirmed: RESULT: PASS");
      return true;
    } else if (content.includes("RESULT: FAIL")) {
      console.warn("❌ Validation failed: RESULT: FAIL");
      const failDir = path.join(__dirname, 'FAIL');
      if (!fs.existsSync(failDir)) fs.mkdirSync(failDir);
      const failName = `fail_validation_${attempt + 1}.png`;
      fs.renameSync(outputPath, path.join(failDir, failName));
      const logPath = path.join(failDir, `fail_validation_${attempt + 1}.txt`);
      fs.writeFileSync(logPath, content, 'utf-8');
      return false;
    }

    await sleep(5000);
  }

  console.warn("⚠️ No RESULT received from validation GPT within 3 minutes.");
  return null;
}

async function run(imagePath) {
  try {
    if (!fs.existsSync(imagePath)) {
      console.error("❌ Input image does not exist:", imagePath);
      process.exit(1);
    }

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      userDataDir: path.resolve(__dirname, './puppeteer-profile'),
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--restore-last-session=false',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking'
      ]
    });

    const pages = await browser.pages();
    const page = pages[0];

    let validated = false;
    let attempt = 0;

    while (!validated && attempt < 10) {
      await randomSleep();
      const result = await generateMovesheet(browser, imagePath, attempt);

      if (result) {
        await randomSleep();
        const valid = await validateWithSecondGPT(page, result, attempt);
        if (valid) {
          validated = true;
        } else {
          console.log("🔁 Retrying generation due to validation failure...");
          attempt++;
        }
      } else {
        console.log("🔁 Retrying generation due to missing transparency...");
        attempt++;
      }
    }

    await browser.close();
  } catch (error) {
    console.error("❌ Runtime error:", error);
  }
}

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("❌ Usage: node generate_sprite_automated.js path/to/image.png [-debug]");
  process.exit(1);
}

run(args[0]);
