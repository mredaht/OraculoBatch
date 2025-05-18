// oracle.js — versión batch con uint32

import "dotenv/config";
import Web3 from "web3";
import fs from "fs";
import retry from "async-retry";
import leagueAbi from "./FantasyLeagueABI.json" with { type: "json" };

function env(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Falta ${name} en .env`);
    return v;
}

// ── Web3 y contrato ─────────────────────────────────────
const web3 = new Web3(env("RPC_URL"));
const acct = web3.eth.accounts.privateKeyToAccount(env("ORACLE_PRIVATE_KEY"));
web3.eth.accounts.wallet.add(acct);

const league = new web3.eth.Contract(leagueAbi, env("LEAGUE_ADDRESS"));

// ── Parámetros ───────────────────────────────────────────
const GAS_LIMIT = 5_000_000;
const STATS_FILE = "./stats.json";

// ── Utilidades ───────────────────────────────────────────
function loadStats() {
    return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
}

function pack32(p) {
    if (p.goles > 8) throw new Error(`goles>8 id=${p.id}`);
    if (p.asistencias > 8) throw new Error(`asis>8 id=${p.id}`);
    if (p.penaltisParados > 4) throw new Error(`penaltisParados>4 id=${p.id}`);
    if (p.paradas > 32 || p.despejes > 64) throw new Error(`paradas/despejes fuera de rango id=${p.id}`);
    if (p.minutosJugados > 90) throw new Error(`minutos>90 id=${p.id}`);
    if (p.tarjetasAmarillas > 2 || p.tarjetasRojas > 1) throw new Error(`tarjetas fuera de rango id=${p.id}`);

    const paradas = Math.min(p.paradas, 31);
    const despejes = Math.min(p.despejes, 63);
    const minutosQ = Math.floor(p.minutosJugados / 3);

    let d = BigInt(p.goles & 0x0F);
    d |= BigInt(p.asistencias & 0x0F) << 4n;
    d |= BigInt(paradas & 0x1F) << 8n;
    d |= BigInt(p.penaltisParados & 0x07) << 13n;
    d |= BigInt(despejes & 0x3F) << 16n;
    d |= BigInt(minutosQ & 0x1F) << 22n;
    d |= BigInt(p.tarjetasAmarillas & 0x03) << 27n;
    d |= BigInt(p.tarjetasRojas & 0x01) << 29n;
    if (p.porteriaCero) d |= 1n << 30n;
    if (p.ganoPartido) d |= 1n << 31n;

    return "0x" + d.toString(16).padStart(8, "0");
}

// ── Main ────────────────────────────────────────────────
(async () => {
    const stats = loadStats();
    const ids = [];
    const datos = [];

    for (const p of stats) {
        if (p.goles === undefined) continue;
        ids.push(p.id);
        datos.push(pack32(p));
    }

    const tx = league.methods.actualizarStatsBatchPacked32(ids, datos);
    const encoded = tx.encodeABI();

    const block = await web3.eth.getBlock("pending");
    const base = BigInt(block.baseFeePerGas);
    const tip = 2n * 10n ** 9n;
    const maxFee = base * 2n + tip;

    const txData = {
        from: acct.address,
        to: league.options.address,
        gas: GAS_LIMIT,
        maxPriorityFeePerGas: tip.toString(),
        maxFeePerGas: maxFee.toString(),
        data: encoded
    };

    console.time("batch");
    await retry(async () => {
        const signed = await acct.signTransaction(txData);
        const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
        console.log(`✅ Gas usado: ${receipt.gasUsed}`);
        console.timeEnd("batch");
    }, {
        retries: 3,
        onRetry: (e, i) => console.log(`Reintento ${i + 1}: ${e.message}`)
    });

    console.log("\n── Resumen ─────────│");
    console.log(`Jugadores procesados : ${ids.length}`);
})();
