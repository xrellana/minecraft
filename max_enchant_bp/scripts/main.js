import { world, system, EquipmentSlot, EnchantmentTypes } from "@minecraft/server";

const VERSION = "1.2";

// Curse enchantments are skipped (and stripped from items) by default.
// Fuzzy match, because the script API ids do not always match the command
// names. Return false unconditionally if you want curses applied as well.
function isCurse(id) {
    const bare = String(id ?? "").toLowerCase();
    return bare.includes("binding") || bare.includes("vanish") || bare.includes("curse");
}

const ALL_SLOTS = [
    EquipmentSlot.Mainhand,
    EquipmentSlot.Offhand,
    EquipmentSlot.Head,
    EquipmentSlot.Chest,
    EquipmentSlot.Legs,
    EquipmentSlot.Feet,
];

// Fallback enchantment id list, used only if EnchantmentTypes.getAll()
// is unavailable in the running API version.
const FALLBACK_IDS = [
    "aqua_affinity", "bane_of_arthropods", "blast_protection", "breach",
    "channeling", "density", "depth_strider", "efficiency", "feather_falling",
    "fire_aspect", "fire_protection", "flame", "fortune", "frost_walker",
    "impaling", "infinity", "knockback", "looting", "loyalty",
    "luck_of_the_sea", "lure", "mending", "multishot", "piercing", "power",
    "projectile_protection", "protection", "punch", "quick_charge",
    "respiration", "riptide", "sharpness", "silk_touch", "smite", "soul_speed",
    "swift_sneak", "thorns", "unbreaking", "wind_burst",
];

function getAllEnchantmentTypes() {
    try {
        const all = EnchantmentTypes.getAll();
        if (all && all.length > 0) return all;
    } catch {
        // Fall through to the hardcoded list.
    }
    return FALLBACK_IDS.map((id) => EnchantmentTypes.get(id)).filter((t) => t);
}

// Apply every compatible enchantment at its max level to the given ItemStack,
// and strip any curse enchantments already on it.
// Returns { added, removed } counts, or null if the item is not enchantable.
function enchantMax(item, player) {
    const enchantable = item?.getComponent("minecraft:enchantable");
    if (!enchantable) return null;

    let removed = 0;
    try {
        for (const existing of enchantable.getEnchantments()) {
            if (isCurse(existing.type.id)) {
                enchantable.removeEnchantment(existing.type);
                removed++;
            }
        }
    } catch (e) {
        player.sendMessage(`§c[MaxEnchant] 移除诅咒时出错: ${e}`);
    }

    let added = 0;
    for (const type of getAllEnchantmentTypes()) {
        if (isCurse(type.id)) continue;
        const enchantment = { type, level: type.maxLevel };
        try {
            // canAddEnchantment also rejects conflicting enchantments
            // (e.g. Sharpness vs Smite), so the first compatible one wins.
            if (enchantable.canAddEnchantment(enchantment)) {
                enchantable.addEnchantment(enchantment);
                added++;
            }
        } catch {
            // Ignore enchantments that cannot be applied to this item.
        }
    }
    return { added, removed };
}

// Print diagnostic info: all known enchantment ids, and what is on the held item.
function debugReport(player) {
    const allIds = getAllEnchantmentTypes().map((t) => `${t.id}`);
    player.sendMessage(`§b[MaxEnchant v${VERSION}] 全部附魔ID(${allIds.length}): §7${allIds.join(", ")}`);

    const equippable = player.getComponent("minecraft:equippable");
    const item = equippable?.getEquipment(EquipmentSlot.Mainhand);
    if (!item) {
        player.sendMessage("§e手上没有物品。");
        return;
    }
    const enchantable = item.getComponent("minecraft:enchantable");
    if (!enchantable) {
        player.sendMessage(`§e${item.typeId} 不可附魔。`);
        return;
    }
    const current = enchantable.getEnchantments().map((e) => `${e.type.id}:${e.level}`);
    player.sendMessage(`§b手上 ${item.typeId} 的附魔(${current.length}): §7${current.join(", ")}`);
}

system.afterEvents.scriptEventReceive.subscribe((event) => {
    if (event.id !== "max:enchant" && event.id !== "max:all" && event.id !== "max:debug") return;

    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;

    try {
        if (event.id === "max:debug") {
            debugReport(player);
            return;
        }

        const equippable = player.getComponent("minecraft:equippable");
        if (!equippable) return;

        const slots = event.id === "max:all" ? ALL_SLOTS : [EquipmentSlot.Mainhand];

        let itemCount = 0;
        let enchantCount = 0;
        let curseCount = 0;
        for (const slot of slots) {
            const item = equippable.getEquipment(slot);
            if (!item) continue;

            const result = enchantMax(item, player);
            if (result && (result.added > 0 || result.removed > 0)) {
                // getEquipment returns a copy, so write the enchanted item back.
                equippable.setEquipment(slot, item);
                itemCount++;
                enchantCount += result.added;
                curseCount += result.removed;
            }
        }

        if (itemCount === 0) {
            player.sendMessage(`§e[v${VERSION}] 没有找到可附魔的装备（或已全部附满）。`);
        } else {
            let msg = `§a[v${VERSION}] 已为 ${itemCount} 件装备附上 ${enchantCount} 个满级附魔！`;
            if (curseCount > 0) msg += ` §d（移除了 ${curseCount} 个诅咒）`;
            player.sendMessage(msg);
        }
    } catch (e) {
        player.sendMessage(`§c[MaxEnchant] 脚本出错: ${e}\n${e?.stack ?? ""}`);
    }
});

// Startup banner so it is easy to confirm which script version actually loaded.
console.warn(`[MaxEnchant] script v${VERSION} loaded`);
world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    system.runTimeout(() => {
        event.player.sendMessage(
            `§b[MaxEnchant v${VERSION}] 已加载：/scriptevent max:enchant（手持）、max:all（全身）、max:debug（诊断）`
        );
    }, 40);
});
