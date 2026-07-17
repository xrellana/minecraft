import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

const VERSION = "1.2";

// The wand is a renamed vanilla breeze rod, so no resource pack is needed
// (the blaze rod is already taken by the Admin Wand pack).
// Both the type id and the display name must match for the menu to open.
const WAND_TYPE = "minecraft:breeze_rod";
const WAND_NAME = "§r§d祝福权杖";
const CONFIG_PROPERTY = "buffwand:config";

// Effects are applied for 60s. Every 5s each buff's remaining duration is
// checked, and any buff missing or below the 30s threshold is re-applied.
// The 30s floor also matters for night vision: below ~10s remaining the
// screen starts flashing dark, and this schedule never gets close to that.
const EFFECT_DURATION_TICKS = 60 * 20;
const REFRESH_INTERVAL_TICKS = 5 * 20;
const REFRESH_THRESHOLD_TICKS = 30 * 20;

// Fun mode amplifier. Amplifiers are 0-based, so 255 shows as level 256 —
// the maximum the /effect command and the script API accept.
const FUN_AMPLIFIER = 255;

// binary: the effect has no meaningful levels (on/off), so fun mode does not
// raise its amplifier.
// funAmplifier: per-buff fun mode override, for effects where 255 is
// unplayable rather than fun.
const BUFFS = [
    { key: "speed", effect: "minecraft:speed", label: "速度 II", amplifier: 1 },
    { key: "haste", effect: "minecraft:haste", label: "急迫 II", amplifier: 1 },
    { key: "strength", effect: "minecraft:strength", label: "力量 II", amplifier: 1 },
    { key: "resistance", effect: "minecraft:resistance", label: "抗性提升 II", amplifier: 1 },
    { key: "regeneration", effect: "minecraft:regeneration", label: "生命恢复 II", amplifier: 1 },
    // Jump boost is capped in fun mode: amplifier 5 (level VI) jumps about
    // 6 blocks, while 255 launches you so high the fall takes ages.
    { key: "jump_boost", effect: "minecraft:jump_boost", label: "跳跃提升 II", amplifier: 1, funAmplifier: 5 },
    { key: "fire_resistance", effect: "minecraft:fire_resistance", label: "防火", amplifier: 0, binary: true },
    { key: "water_breathing", effect: "minecraft:water_breathing", label: "水下呼吸", amplifier: 0, binary: true },
    { key: "night_vision", effect: "minecraft:night_vision", label: "夜视", amplifier: 0, binary: true },
    { key: "slow_falling", effect: "minecraft:slow_falling", label: "缓降", amplifier: 0, binary: true },
    { key: "saturation", effect: "minecraft:saturation", label: "饱和", amplifier: 0 },
    { key: "health_boost", effect: "minecraft:health_boost", label: "生命提升 II（+4❤）", amplifier: 1 },
];

function isWand(item) {
    return item?.typeId === WAND_TYPE && item?.nameTag === WAND_NAME;
}

// ---------------------------------------------------------------------------
// Per-player config, persisted via dynamic properties so it survives
// relogging and world reloads. Shape: { buffs: ["speed", ...], fun: false }
// ---------------------------------------------------------------------------

function loadConfig(player) {
    const raw = player.getDynamicProperty(CONFIG_PROPERTY);
    if (typeof raw !== "string") return { buffs: [], fun: false };
    try {
        const parsed = JSON.parse(raw);
        const known = new Set(BUFFS.map((b) => b.key));
        return {
            buffs: Array.isArray(parsed.buffs) ? parsed.buffs.filter((k) => known.has(k)) : [],
            fun: parsed.fun === true,
        };
    } catch {
        return { buffs: [], fun: false };
    }
}

function saveConfig(player, config) {
    player.setDynamicProperty(CONFIG_PROPERTY, JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// Applying / refreshing / removing effects
// ---------------------------------------------------------------------------

function applyBuffs(player, config, { topUpOnly = false } = {}) {
    const enabled = new Set(config.buffs);
    for (const buff of BUFFS) {
        if (!enabled.has(buff.key)) continue;
        // In top-up mode, leave buffs alone while they still have plenty of
        // time left; only re-apply the ones that are missing or running low.
        if (topUpOnly) {
            let remaining = 0;
            try {
                remaining = player.getEffect(buff.effect)?.duration ?? 0;
            } catch {
                // Unknown effect on this API version; addEffect below will
                // also fail and be skipped.
            }
            if (remaining > REFRESH_THRESHOLD_TICKS) continue;
        }
        const amplifier = config.fun && !buff.binary
            ? (buff.funAmplifier ?? FUN_AMPLIFIER)
            : buff.amplifier;
        try {
            player.addEffect(buff.effect, EFFECT_DURATION_TICKS, {
                amplifier,
                showParticles: false,
            });
        } catch {
            // Effect not available on this API version; skip it.
        }
    }
}

// Remove every effect managed by this pack. Re-adding an effect with a LOWER
// amplifier does not override an active higher one, so a clean remove +
// re-apply is the only reliable way to switch fun mode off.
function removeManagedBuffs(player) {
    for (const buff of BUFFS) {
        try {
            player.removeEffect(buff.effect);
        } catch {
            // Not active or unknown; ignore.
        }
    }
}

function removeAllEffects(player) {
    let removed = 0;
    for (const effect of player.getEffects()) {
        try {
            player.removeEffect(effect.typeId);
            removed++;
        } catch {
            // Some effects may not be removable; ignore.
        }
    }
    return removed;
}

// The refresh loop: keep every configured player's buffs topped up.
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        const config = loadConfig(player);
        if (config.buffs.length > 0) applyBuffs(player, config, { topUpOnly: true });
    }
}, REFRESH_INTERVAL_TICKS);

// ---------------------------------------------------------------------------
// Buff config form (a single modal that both enables and disables:
// toggles open pre-checked with the current state, submit syncs everything)
// ---------------------------------------------------------------------------

function openConfigForm(player) {
    const config = loadConfig(player);
    const enabled = new Set(config.buffs);

    const form = new ModalFormData().title("§l配置常驻 Buff");
    form.toggle("§d🎉 整活模式§r §7（buff 按 255 级施加；跳跃提升约跳 6 格）", config.fun);
    for (const buff of BUFFS) {
        form.toggle(buff.label, enabled.has(buff.key));
    }

    form.show(player).then((response) => {
        if (response.canceled) return;
        try {
            const values = response.formValues;
            const newConfig = {
                fun: values[0] === true,
                buffs: BUFFS.filter((_, i) => values[i + 1] === true).map((b) => b.key),
            };

            // Clean slate so both unchecked buffs and amplifier changes
            // (fun mode on/off) take effect immediately.
            removeManagedBuffs(player);
            saveConfig(player, newConfig);
            applyBuffs(player, newConfig);

            if (newConfig.buffs.length === 0) {
                player.sendMessage("§e已关闭全部常驻 Buff。");
            } else {
                let msg = `§a已启用 ${newConfig.buffs.length} 个常驻 Buff，掉线重连也会自动恢复。`;
                if (newConfig.fun) msg += " §d🎉 整活模式已开启（255 级）！";
                player.sendMessage(msg);
            }
        } catch (e) {
            player.sendMessage(`§c[祝福权杖] 执行出错: ${e}\n${e?.stack ?? ""}`);
        }
    });
}

// ---------------------------------------------------------------------------
// Clear all effects (also disables the persistent config, otherwise the
// refresh loop would re-apply everything within seconds)
// ---------------------------------------------------------------------------

function actionClearAllEffects(player) {
    const config = loadConfig(player);
    saveConfig(player, { buffs: [], fun: config.fun });
    const removed = removeAllEffects(player);
    if (removed === 0) {
        player.sendMessage("§e身上没有任何状态效果。");
    } else {
        player.sendMessage(`§a已清除 ${removed} 个状态效果，常驻 Buff 已一并关闭。`);
    }
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

function openMenu(player) {
    const config = loadConfig(player);
    const status =
        config.buffs.length === 0
            ? "§7当前没有启用常驻 Buff。"
            : `§7当前启用 §a${config.buffs.length}§7 个常驻 Buff` +
              (config.fun ? "，§d整活模式开启中（255 级）" : "") + "。";

    const form = new ActionFormData()
        .title("§l祝福权杖")
        .body(`${status}\n\n选择一个功能：`)
        .button("配置常驻 Buff »\n§7勾选开启，取消勾选关闭")
        .button("清除所有效果\n§7包括中毒、凋零等负面效果");

    form.show(player).then((response) => {
        if (response.canceled) return;
        try {
            if (response.selection === 0) openConfigForm(player);
            else if (response.selection === 1) actionClearAllEffects(player);
        } catch (e) {
            player.sendMessage(`§c[祝福权杖] 执行出错: ${e}\n${e?.stack ?? ""}`);
        }
    });
}

world.afterEvents.itemUse.subscribe((event) => {
    if (!isWand(event.itemStack)) return;
    const player = event.source;
    if (!player || player.typeId !== "minecraft:player") return;
    // Defer one tick so the form is not dismissed as "UserBusy" while the
    // use animation is still in progress.
    system.run(() => openMenu(player));
});

// ---------------------------------------------------------------------------
// Getting the wand: /scriptevent buff:give
// ---------------------------------------------------------------------------

function giveWand(player) {
    const wand = new ItemStack(WAND_TYPE, 1);
    wand.nameTag = WAND_NAME;
    wand.setLore(["§7长按（使用）配置常驻 Buff"]);
    const container = player.getComponent("minecraft:inventory")?.container;
    const leftover = container?.addItem(wand);
    if (leftover) {
        player.sendMessage("§e背包已满，无法给予权杖。");
    } else {
        player.sendMessage("§a已获得 §d祝福权杖§a！手持并长按（使用）即可打开菜单。");
    }
}

system.afterEvents.scriptEventReceive.subscribe((event) => {
    if (event.id !== "buff:give") return;
    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;
    giveWand(player);
});

// Startup banner so it is easy to confirm which script version actually loaded.
console.warn(`[BuffWand] script v${VERSION} loaded`);
world.afterEvents.playerSpawn.subscribe((event) => {
    // Restore buffs immediately on join and after respawn (death clears all
    // effects) instead of waiting for the next refresh tick.
    const config = loadConfig(event.player);
    if (config.buffs.length > 0) applyBuffs(event.player, config);

    if (!event.initialSpawn) return;
    system.runTimeout(() => {
        event.player.sendMessage(
            `§d[祝福权杖 v${VERSION}] 已加载：输入 /scriptevent buff:give 获取权杖`
        );
    }, 40);
});
