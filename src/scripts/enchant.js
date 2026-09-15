// Max-enchant: apply every compatible enchantment at its highest level.

import { EquipmentSlot, EnchantmentTypes } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { isWand, showActionMenu } from "./core.js";

// Curse enchantments are skipped (and stripped from items) by default.
// Fuzzy match, because the script API ids do not always match the command names.
function isCurse(id) {
    const bare = String(id ?? "").toLowerCase();
    return bare.includes("binding") || bare.includes("vanish") || bare.includes("curse");
}

// Equipment slots that are NOT part of the 36-slot inventory container.
// Mainhand is deliberately absent: it maps to the selected hotbar slot, which
// the container scan already covers (and it usually holds the wand anyway).
const EQUIP_SLOTS = [
    EquipmentSlot.Offhand,
    EquipmentSlot.Head,
    EquipmentSlot.Chest,
    EquipmentSlot.Legs,
    EquipmentSlot.Feet,
];
const EQUIP_SLOT_NAMES = {
    [EquipmentSlot.Offhand]: "副手",
    [EquipmentSlot.Head]: "头部",
    [EquipmentSlot.Chest]: "胸部",
    [EquipmentSlot.Legs]: "腿部",
    [EquipmentSlot.Feet]: "脚部",
};

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
function enchantMax(item) {
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
    } catch {
        // Ignore items whose enchantment list cannot be read.
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

function describeItem(item) {
    return item.nameTag ?? item.typeId.replace("minecraft:", "");
}

function reportEnchantResult(player, itemCount, enchantCount, curseCount) {
    if (itemCount === 0) {
        player.sendMessage("§e没有找到可附魔的物品（或已全部附满）。");
    } else {
        let msg = `§a已为 ${itemCount} 件物品附上 ${enchantCount} 个满级附魔！`;
        if (curseCount > 0) msg += ` §d（移除了 ${curseCount} 个诅咒）`;
        player.sendMessage(msg);
    }
}

// Enchant worn equipment plus every enchantable item in the inventory, so the
// wand does not need to leave the hand to reach the target item.
function actionEnchantEverything(player) {
    const equippable = player.getComponent("minecraft:equippable");
    const container = player.getComponent("minecraft:inventory")?.container;

    let itemCount = 0;
    let enchantCount = 0;
    let curseCount = 0;

    const tally = (result) => {
        if (!result || (result.added === 0 && result.removed === 0)) return false;
        itemCount++;
        enchantCount += result.added;
        curseCount += result.removed;
        return true;
    };

    if (equippable) {
        for (const slot of EQUIP_SLOTS) {
            const item = equippable.getEquipment(slot);
            if (!item || isWand(item)) continue;
            // getEquipment returns a copy, so write the enchanted item back.
            if (tally(enchantMax(item))) equippable.setEquipment(slot, item);
        }
    }
    if (container) {
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (!item || isWand(item)) continue;
            if (tally(enchantMax(item))) container.setItem(i, item);
        }
    }
    reportEnchantResult(player, itemCount, enchantCount, curseCount);
}

// Let the player pick a single enchantable item from equipment + inventory.
function actionEnchantPick(player) {
    const equippable = player.getComponent("minecraft:equippable");
    const container = player.getComponent("minecraft:inventory")?.container;

    const targets = [];
    if (equippable) {
        for (const slot of EQUIP_SLOTS) {
            const item = equippable.getEquipment(slot);
            if (!item || isWand(item) || !item.getComponent("minecraft:enchantable")) continue;
            targets.push({
                label: `${describeItem(item)}\n§7装备栏 · ${EQUIP_SLOT_NAMES[slot]}`,
                apply: () => {
                    const result = enchantMax(item);
                    equippable.setEquipment(slot, item);
                    return result;
                },
            });
        }
    }
    if (container) {
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (!item || isWand(item) || !item.getComponent("minecraft:enchantable")) continue;
            const slotIndex = i;
            targets.push({
                label: `${describeItem(item)}\n§7${slotIndex < 9 ? "快捷栏" : "背包"} ${slotIndex} 号槽`,
                apply: () => {
                    const result = enchantMax(item);
                    container.setItem(slotIndex, item);
                    return result;
                },
            });
        }
    }

    if (targets.length === 0) {
        player.sendMessage("§e身上和背包里都没有可附魔的物品。");
        return;
    }

    showActionMenu(player, {
        form: new ActionFormData()
            .title("§l选择要附魔的物品")
            .body("挑一件，一键附满："),
        actions: targets.map((target) => ({
            label: target.label,
            handler: () => {
                const result = target.apply();
                reportEnchantResult(player, result ? 1 : 0, result?.added ?? 0, result?.removed ?? 0);
            },
        })),
    });
}

const ENCHANT_MENU_ACTIONS = [
    { label: "全部满附魔\n§7装备 + 背包里所有能附魔的物品", handler: actionEnchantEverything },
    { label: "选择单件附魔\n§7从列表里挑一件", handler: actionEnchantPick },
];

export function openEnchantMenu(player) {
    showActionMenu(player, {
        form: new ActionFormData().title("§l一键满附魔").body("选择附魔方式："),
        actions: ENCHANT_MENU_ACTIONS,
    });
}
