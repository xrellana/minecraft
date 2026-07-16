import { world, system, EquipmentSlot, EnchantmentTypes } from "@minecraft/server";

const VERSION = "1.3";

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

// Mutually exclusive enchantment groups, in preference order. For each group,
// members already on the item are stripped first so a lower-priority one
// (e.g. Smite) cannot block the preferred one (Sharpness), then the first
// member the item accepts is applied at max level. Later members act as
// fallbacks for items the winner does not fit (e.g. Density for maces, or
// Mending for everything that is not a bow).
const EXCLUSIVE_GROUPS = [
    // Melee damage: swords/axes get Sharpness, maces fall through to Density.
    ["sharpness", "density", "breach", "smite", "bane_of_arthropods"],
    // Armor: plain Protection over the element-specific ones.
    ["protection", "fire_protection", "blast_protection", "projectile_protection"],
    // Digging tools: Fortune over Silk Touch.
    ["fortune", "silk_touch"],
    // Boots: Depth Strider over Frost Walker.
    ["depth_strider", "frost_walker"],
    // Bows: Infinity over Mending (they only conflict on bows).
    ["infinity", "mending"],
    // Crossbows: Multishot over Piercing.
    ["multishot", "piercing"],
    // Tridents: Loyalty + Channeling over Riptide (Riptide conflicts with both).
    ["loyalty", "riptide"],
    ["channeling", "riptide"],
];
const EXCLUSIVE_IDS = new Set(EXCLUSIVE_GROUPS.flat());

// Normalize so "minecraft:sharpness" and "sharpness" compare equal.
function bareId(id) {
    return String(id ?? "").toLowerCase().replace("minecraft:", "");
}

// Apply every compatible enchantment at its max level to the given ItemStack,
// and strip any curse enchantments already on it. Mutually exclusive
// enchantments are resolved by EXCLUSIVE_GROUPS preference, replacing any
// lower-priority member already on the item.
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

    const types = getAllEnchantmentTypes();
    const typesById = new Map(types.map((t) => [bareId(t.id), t]));

    const tryAdd = (type) => {
        try {
            const enchantment = { type, level: type.maxLevel };
            if (enchantable.canAddEnchantment(enchantment)) {
                enchantable.addEnchantment(enchantment);
                return true;
            }
        } catch {
            // Ignore enchantments that cannot be applied to this item.
        }
        return false;
    };

    let added = 0;
    for (const group of EXCLUSIVE_GROUPS) {
        // Strip existing members so they cannot block a higher-priority one.
        const stripped = [];
        try {
            for (const existing of enchantable.getEnchantments()) {
                if (group.includes(bareId(existing.type.id))) {
                    stripped.push({ type: existing.type, level: existing.level });
                    enchantable.removeEnchantment(existing.type);
                }
            }
        } catch {
            // Ignore items whose enchantment list cannot be read.
        }
        let winner;
        for (const id of group) {
            const type = typesById.get(id);
            if (type && tryAdd(type)) {
                winner = type;
                break;
            }
        }
        if (winner) {
            // Count only real changes, so re-running an already maxed item
            // still reports "nothing to do".
            const alreadyHadWinner = stripped.some(
                (s) => bareId(s.type.id) === bareId(winner.id) && s.level === winner.maxLevel
            );
            if (!alreadyHadWinner) added++;
        } else {
            // The item takes none of the group (should only happen if the API
            // rejects a re-add); restore whatever was stripped.
            for (const s of stripped) {
                try {
                    enchantable.addEnchantment({ type: s.type, level: s.level });
                } catch {
                    // Nothing more we can do; the enchantment is lost.
                }
            }
        }
    }

    // Everything outside the exclusive groups has no conflicts; apply it all.
    for (const type of types) {
        if (isCurse(type.id)) continue;
        if (EXCLUSIVE_IDS.has(bareId(type.id))) continue;
        if (tryAdd(type)) added++;
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
