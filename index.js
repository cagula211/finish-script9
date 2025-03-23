Const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const Pino = require("pino");
const fs = require("fs");
const readline = require("readline");
const process = require("process");
const dns = require("dns");
const chalk = require("chalk"); // Colorare text

// Interfață pentru input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Delay
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// Fișiere progres și autentificare
const PROGRESS_FILE = "progress.json";
const AUTH_FOLDER = "./auth_info";

// Salvare progres
function saveProgress(index) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastIndex: index }), "utf-8");
}

// Încărcare progres
function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
            return data.lastIndex || 0;
        } catch (e) {
            return 0;
        }
    }
    return 0;
}

// Întrebare input
function askQuestion(query) {
    return new Promise((resolve) => {
        rl.question(chalk.red(query), (answer) => {
            resolve(answer.trim());
        });
    });
}

// Verificare internet
async function waitForInternet() {
    console.log(chalk.red("🔄 Aștept conexiunea la internet..."));
    return new Promise((resolve) => {
        const interval = setInterval(() => {
            dns.resolve("google.com", (err) => {
                if (!err) {
                    console.log(chalk.red("✅ Internetul a revenit! Reîncerc conectarea..."));
                    clearInterval(interval);
                    resolve(true);
                }
            });
        }, 5000);
    });
}

// Afișăm bannerul la început
console.log(chalk.red(`
===================================
         CAGULA ZEUL
===================================
`));

// Inițializează conexiunea stabilă
async function startBot() {
    console.log(chalk.red("🔥 Pornire bot WhatsApp..."));
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    let socket = makeWASocket({
        auth: state,
        logger: Pino({ level: "silent" }), // Dezactivare loguri inutile
        connectTimeoutMs: 60000
    });

    // Dacă nu există sesiune, cere pairing code
    if (!socket.authState.creds.registered) {
        const phoneNumber = "393533870586"; // Numărul tău de telefon
        try {
            const pairingCode = await socket.requestPairingCode(phoneNumber);
            console.log(chalk.red(`✅ Pairing code: ${pairingCode}`));
            console.log(chalk.red("🔗 Open WhatsApp and enter this code in 'Linked Devices'."));
        } catch (error) {
            console.error(chalk.red("❌ Eroare generare pairing code:", error));
        }
    } else {
        console.log(chalk.red("✅ Conectat deja!"));
    }

    // Gestionare evenimente conexiune
    socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "open") {
            console.log(chalk.red("✅ Conectat la WhatsApp!"));
            await afterConnection(socket);
        } else if (connection === "close") {
            console.log(chalk.red("⚠️ Conexiunea s-a întrerupt."));
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                await waitForInternet();
                await startBot();
            } else {
                console.log(chalk.red("❌ Deconectare definitivă. Restart manual necesar."));
                process.exit(1);
            }
        }
    });

    // Salvare credențiale
    socket.ev.on("creds.update", saveCreds);
}

// După conectare, gestionează trimiterea mesajelor
async function afterConnection(sock) {
    let targets, messages, messageDelay;

    // Dacă deja există date salvate, nu mai cerem
    if (globalThis.targets && globalThis.messages && globalThis.messageDelay) {
        console.log(chalk.red("📩 Reluare trimitere mesaje de unde a rămas..."));
        targets = globalThis.targets;
        messages = globalThis.messages;
        messageDelay = globalThis.messageDelay;
    } else {
        console.log(chalk.red("\n🌐 Selectează unde dorești să trimiți mesaje:"));
        console.log(chalk.red("[1] Contacte"));
        console.log(chalk.red("[2] Grupuri"));
        const choice = await askQuestion(chalk.red("🔹 Alegere (1/2): "));

        targets = [];

        if (choice === "1") {
            const numContacts = parseInt(await askQuestion(chalk.red("📞 Câte contacte? ")), 10);
            for (let i = 0; i < numContacts; i++) {
                const targetNumber = await askQuestion(chalk.red(`📱 Număr contact ${i + 1} (ex. 40771578291): `));
                targets.push(`${targetNumber}@s.whatsapp.net`);
            }
        } else if (choice === "2") {
            console.log(chalk.red("🔄 Se încarcă grupurile..."));
            try {
                const groupMetadata = await sock.groupFetchAllParticipating();
                const groups = Object.values(groupMetadata);

                console.log(chalk.red("\n👥 Grupuri disponibile:"));
                groups.forEach((g, index) => {
                    console.log(chalk.red(`[${index + 1}] ${g.subject}`));
                });

                const selectedGroups = await askQuestion(chalk.red("📌 Introdu numerele grupurilor (ex. 1,2,3): "));
                const groupIndexes = selectedGroups.split(",").map((num) => parseInt(num.trim(), 10) - 1);

                groupIndexes.forEach((idx) => {
                    if (groups[idx]) {
                        targets.push(groups[idx].id);
                    }
                });
            } catch (error) {
                console.error(chalk.red("❌ Eroare la obținerea grupurilor:", error));
                process.exit(1);
            }
        } else {
            console.log(chalk.red("❌ Opțiune invalidă. Iesire..."));
            process.exit(1);
        }

        console.log(chalk.red("✍️ Introdu textul pentru WhatsApp rând cu rând. Când ai terminat, scrie 'gata'."));
        messages = [];
        while (true) {
            const line = await askQuestion(chalk.red("📝 Text: "));
            if (line.toLowerCase() === "gata") break;
            messages.push(line);
        }

        messageDelay = parseInt(await askQuestion(chalk.red("⏳ Delay între mesaje (secunde): ")), 10) * 1000;

        // Salvăm datele în globalThis
        globalThis.targets = targets;
        globalThis.messages = messages;
        globalThis.messageDelay = messageDelay;
    }

    resumeSending(sock, targets, messages, messageDelay);
}

// Trimiterea mesajelor
async function resumeSending(sock, targets, messages, messageDelay) {
    let currentIndex = loadProgress();

    while (true) {
        for (let i = currentIndex; i < messages.length; i++) {
            for (const target of targets) {
                try {
                    // Trimite mesaj
                    await sock.sendMessage(target, { text: messages[i] });

                    // Afișare detalii
                    const now = new Date();
                    const formattedDate = now.toLocaleDateString("ro-RO", { day: "numeric", month: "long" });
                    const formattedTime = now.toLocaleTimeString("ro-RO");

                    console.log(chalk.red(`\n📤 Trimite către ${target}: "${messages[i]}"`));
                    console.log(chalk.red(`CAGULA ZEUL`));
                    console.log(chalk.red(`🕒 ${formattedDate} ${formattedTime}`));

                    // Salvare progres
