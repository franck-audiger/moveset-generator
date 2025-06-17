const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { PNG } = require('pngjs');

const CHATGPT_URL = "https://chat.openai.com/";

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

async function downloadImage(imageUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(imageUrl, response => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function generatePosition(page, imagePath, basePrompt, index, imageUrl, previousUrls) {
  console.log(`📨 Prompt ${index + 1} => "${basePrompt}"`);
  await page.type('.ProseMirror', basePrompt);
  await sleep(5000);
  await randomSleep();
  await page.keyboard.press('Enter');

  const timeoutMs = 180000;
  const start = Date.now();

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
      const tmpPath = `gendataset-output/tmp-output${index}.png`;
      await downloadImage(imageUrl, tmpPath);
      const complete = isPngComplete(tmpPath);
      if (complete) {
		const finalPath = `gendataset-output/output${index}.png`;
        fs.renameSync(tmpPath, finalPath);
        console.log(`✅ Image ${index + 1} générée et sauvegardée : ${finalPath}`);
        return 'output.png';
      } else { 
        console.log(`🕒 Image en cours de génération pour le prompt ${index + 1} (5 minutes max)...`);
	  }
    } else {
      console.log(`🕒 Attente d'une image pour le prompt ${index + 1} (5 minutes max)...`);
	}
    await sleep(10000);
  }
  throw new Error("⛔ No valid PNG generated.");
}

async function run(imagePath, promptsFilePath) {
  try {
    if (!fs.existsSync(imagePath) || !fs.existsSync(promptsFilePath)) {
      console.error("❌ Image d’entrée ou fichier de prompts manquant.");
      process.exit(1);
    }
	  
    const prompts = fs.readFileSync(promptsFilePath, 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

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

    let previousUrls = new Set();
    const pages = await browser.pages();	
    page = pages[0];
    await randomSleep();
    await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('.ProseMirror', { timeout: 60000 });
    await randomSleep();
    
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error("Cannot find file input.");
    await fileInput.uploadFile(path.resolve(imagePath));
	
	let imageUrl = null;
    for (let i = 0; i < prompts.length; i++) {
	  await generatePosition(page, imagePath, prompts[i], i, imageUrl, previousUrls);
	}
    await page.close();
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

run(args[0], args[1]);
