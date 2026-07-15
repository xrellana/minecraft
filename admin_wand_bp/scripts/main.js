import {
    world,
    system,
    ItemStack,
    EquipmentSlot,
    EnchantmentTypes,
} from "@minecraft/server";
// Namespace import so optional APIs (e.g. BlockTypes) can be probed without
// crashing the module load on older script API versions.
import * as mc from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";

const VERSION = "1.2";

// The wand is a renamed vanilla blaze rod, so no resource pack is needed.
// Both the type id and the display name must match for the menu to open.
const WAND_TYPE = "minecraft:blaze_rod";
const WAND_NAME = "§r§b管理员权杖";
const HOME_PROPERTY = "adminwand:home";

function isWand(item) {
    return item?.typeId === WAND_TYPE && item?.nameTag === WAND_NAME;
}

// ---------------------------------------------------------------------------
// Max enchant (same logic as the Max Enchant Helper pack)
// ---------------------------------------------------------------------------

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

// Apply every compatible enchantment at its max level to the given ItemStack,
// and strip any curse enchantments already on it.
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
                label: `${describeItem(item)}\n§7背包 ${slotIndex < 9 ? "快捷栏" : ""} ${slotIndex} 号槽`,
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

    const form = new ActionFormData()
        .title("§l选择要附魔的物品")
        .body("挑一件，一键附满：");
    for (const target of targets) {
        form.button(target.label);
    }
    form.show(player).then((response) => {
        if (response.canceled) return;
        const target = targets[response.selection];
        if (!target) return;
        try {
            const result = target.apply();
            reportEnchantResult(player, result ? 1 : 0, result?.added ?? 0, result?.removed ?? 0);
        } catch (e) {
            player.sendMessage(`§c[权杖] 附魔出错: ${e}`);
        }
    });
}

function openEnchantMenu(player) {
    const form = new ActionFormData()
        .title("§l一键满附魔")
        .body("选择附魔方式：")
        .button("全部满附魔\n§7装备 + 背包里所有能附魔的物品")
        .button("选择单件附魔\n§7从列表里挑一件");
    form.show(player).then((response) => {
        if (response.canceled) return;
        try {
            if (response.selection === 0) actionEnchantEverything(player);
            else if (response.selection === 1) actionEnchantPick(player);
        } catch (e) {
            player.sendMessage(`§c[权杖] 执行出错: ${e}\n${e?.stack ?? ""}`);
        }
    });
}

// ---------------------------------------------------------------------------
// Clear inventory (keeps the wand itself and worn armor)
// ---------------------------------------------------------------------------

function actionClearInventory(player) {
    const confirm = new MessageFormData()
        .title("清理背包")
        .body("确定要清空背包吗？\n§7权杖本身和身上穿的盔甲会保留。§r\n\n§c此操作无法撤销！")
        .button1("§c确认清理")
        .button2("取消");

    confirm.show(player).then((response) => {
        if (response.canceled || response.selection !== 0) return;

        const container = player.getComponent("minecraft:inventory")?.container;
        if (!container) return;

        let cleared = 0;
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (!item || isWand(item)) continue;
            container.setItem(i, undefined);
            cleared++;
        }
        player.sendMessage(`§a背包已清理，共移除 ${cleared} 组物品。`);
    });
}

// ---------------------------------------------------------------------------
// Day / night toggle
// ---------------------------------------------------------------------------

function actionToggleDayNight(player) {
    // Night runs from 13000 to 23000; anything else counts as day.
    const time = world.getTimeOfDay();
    if (time >= 13000 && time < 23000) {
        world.setTimeOfDay(1000);
        player.sendMessage("§e已切换到白天 ☀");
    } else {
        world.setTimeOfDay(13000);
        player.sendMessage("§9已切换到黑夜 ☽");
    }
}

// ---------------------------------------------------------------------------
// Home (persisted per player via dynamic properties)
// ---------------------------------------------------------------------------

function actionSetHome(player) {
    const home = {
        x: Math.floor(player.location.x),
        y: Math.floor(player.location.y),
        z: Math.floor(player.location.z),
        dimension: player.dimension.id,
    };
    player.setDynamicProperty(HOME_PROPERTY, JSON.stringify(home));
    player.sendMessage(`§a家已设置在 §f(${home.x}, ${home.y}, ${home.z})§a，维度：${home.dimension}`);
}

function actionGoHome(player) {
    const raw = player.getDynamicProperty(HOME_PROPERTY);
    if (typeof raw !== "string") {
        player.sendMessage("§e还没有设置过家，请先使用【设置当前位置为家】。");
        return;
    }
    try {
        const home = JSON.parse(raw);
        const dimension = world.getDimension(home.dimension);
        player.teleport(
            { x: home.x + 0.5, y: home.y, z: home.z + 0.5 },
            { dimension }
        );
        player.sendMessage(`§a已返回家 §f(${home.x}, ${home.y}, ${home.z})`);
    } catch (e) {
        player.sendMessage(`§c传送失败: ${e}`);
    }
}

// ---------------------------------------------------------------------------
// Inventory toolbox: categorization rules
// ---------------------------------------------------------------------------

// Items on this list are deleted by "sort inventory". Customize freely.
const JUNK_IDS = new Set([
    "minecraft:rotten_flesh",
    "minecraft:poisonous_potato",
]);

const TOOL_SUFFIXES = ["_sword", "_pickaxe", "_axe", "_shovel", "_hoe"];
const TOOL_IDS = new Set([
    "minecraft:bow", "minecraft:crossbow", "minecraft:trident",
    "minecraft:mace", "minecraft:shears", "minecraft:fishing_rod",
    "minecraft:flint_and_steel", "minecraft:shield", "minecraft:brush",
]);

// Fallback food list, used when the item lacks a readable food component.
const FOOD_IDS = new Set([
    "minecraft:apple", "minecraft:golden_apple", "minecraft:enchanted_golden_apple",
    "minecraft:bread", "minecraft:cookie", "minecraft:pumpkin_pie", "minecraft:cake",
    "minecraft:beef", "minecraft:cooked_beef", "minecraft:porkchop", "minecraft:cooked_porkchop",
    "minecraft:chicken", "minecraft:cooked_chicken", "minecraft:mutton", "minecraft:cooked_mutton",
    "minecraft:rabbit", "minecraft:cooked_rabbit", "minecraft:cod", "minecraft:cooked_cod",
    "minecraft:salmon", "minecraft:cooked_salmon", "minecraft:dried_kelp",
    "minecraft:potato", "minecraft:baked_potato", "minecraft:carrot", "minecraft:golden_carrot",
    "minecraft:beetroot", "minecraft:melon_slice", "minecraft:sweet_berries", "minecraft:glow_berries",
    "minecraft:mushroom_stew", "minecraft:rabbit_stew", "minecraft:beetroot_soup",
    "minecraft:suspicious_stew", "minecraft:honey_bottle", "minecraft:chorus_fruit",
]);

const ORE_MATERIAL_IDS = new Set([
    "minecraft:coal", "minecraft:charcoal", "minecraft:raw_iron",
    "minecraft:iron_ingot", "minecraft:iron_nugget", "minecraft:raw_gold",
    "minecraft:gold_ingot", "minecraft:gold_nugget", "minecraft:raw_copper",
    "minecraft:copper_ingot", "minecraft:diamond", "minecraft:emerald",
    "minecraft:lapis_lazuli", "minecraft:redstone", "minecraft:quartz",
    "minecraft:netherite_ingot", "minecraft:netherite_scrap",
    "minecraft:ancient_debris", "minecraft:amethyst_shard",
    "minecraft:coal_block", "minecraft:iron_block", "minecraft:gold_block",
    "minecraft:copper_block", "minecraft:diamond_block", "minecraft:emerald_block",
    "minecraft:lapis_block", "minecraft:redstone_block", "minecraft:netherite_block",
    "minecraft:raw_iron_block", "minecraft:raw_gold_block", "minecraft:raw_copper_block",
]);

// Heuristic block detection fallback for when BlockTypes is unavailable.
const BLOCK_ID_HINTS = [
    "_planks", "_log", "_wood", "_stone", "_bricks", "_block", "_wool",
    "_concrete", "_terracotta", "_glass", "_slab", "_stairs", "_fence",
    "_wall", "_leaves", "_sand", "_sandstone", "_ore", "_deepslate",
];
const BLOCK_EXACT_IDS = new Set([
    "minecraft:stone", "minecraft:cobblestone", "minecraft:dirt",
    "minecraft:grass_block", "minecraft:sand", "minecraft:gravel",
    "minecraft:glass", "minecraft:obsidian", "minecraft:netherrack",
    "minecraft:end_stone", "minecraft:deepslate", "minecraft:cobbled_deepslate",
    "minecraft:andesite", "minecraft:diorite", "minecraft:granite",
    "minecraft:tuff", "minecraft:calcite", "minecraft:basalt", "minecraft:glowstone",
]);

function isTool(item) {
    const id = item.typeId;
    return TOOL_IDS.has(id) || TOOL_SUFFIXES.some((s) => id.endsWith(s));
}

function isFood(item) {
    try {
        if (item.getComponent("minecraft:food")) return true;
    } catch {
        // Component not readable on this API version; use the fallback list.
    }
    return FOOD_IDS.has(item.typeId);
}

function isOreMaterial(item) {
    return ORE_MATERIAL_IDS.has(item.typeId) || item.typeId.endsWith("_ore");
}

function isBlockItem(item) {
    try {
        if (mc.BlockTypes?.get?.(item.typeId)) return true;
    } catch {
        // BlockTypes not exposed at this module version; fall through.
    }
    const id = item.typeId;
    return BLOCK_EXACT_IDS.has(id) || BLOCK_ID_HINTS.some((h) => id.endsWith(h));
}

// Category precedence matters: ore blocks (e.g. iron_block) should group with
// ores, so the ore check runs before the generic block check.
function categoryOf(item) {
    if (isTool(item)) return "tools";
    if (isFood(item)) return "food";
    if (isOreMaterial(item)) return "ores";
    if (isBlockItem(item)) return "blocks";
    return "misc";
}

// ---------------------------------------------------------------------------
// Inventory toolbox: snapshot helpers
//
// All operations follow the same safe pattern: (1) snapshot every stack into
// a plain array, (2) compute the result purely in JS, (3) clear the slots and
// write each resulting stack back exactly once. Nothing is ever moved while
// iterating live container slots, so no item can be moved twice.
// ---------------------------------------------------------------------------

function snapshotInventory(container) {
    const items = [];
    let wandSlot = -1;
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        if (!item) continue;
        if (wandSlot === -1 && isWand(item)) {
            wandSlot = i; // the wand stays where it is, always
            continue;
        }
        items.push(item);
    }
    return { items, wandSlot };
}

// Merge stackable duplicates. Non-stackable items (tools etc.) pass through.
function mergeStacks(items) {
    const singles = [];
    const groups = [];
    for (const item of items) {
        if (item.maxAmount <= 1) {
            singles.push(item);
            continue;
        }
        const group = groups.find((g) => g.sample.isStackableWith(item));
        if (group) group.total += item.amount;
        else groups.push({ sample: item, total: item.amount });
    }
    const merged = [];
    for (const g of groups) {
        let left = g.total;
        while (left > 0) {
            const stack = g.sample.clone();
            stack.amount = Math.min(left, g.sample.maxAmount);
            merged.push(stack);
            left -= stack.amount;
        }
    }
    return [...singles, ...merged];
}

function emitStacks(typeId, count, list) {
    const max = new ItemStack(typeId, 1).maxAmount;
    while (count > 0) {
        const n = Math.min(count, max);
        list.push(new ItemStack(typeId, n));
        count -= n;
    }
}

// Clear all non-wand slots and write the given stacks back in order.
// Stacks that no longer fit are dropped at the player's feet; returns how
// many items overflowed (0 in the common case).
function writeBack(player, container, wandSlot, stacks) {
    for (let i = 0; i < container.size; i++) {
        if (i === wandSlot) continue;
        container.setItem(i, undefined);
    }
    let overflow = 0;
    let idx = 0;
    for (const stack of stacks) {
        if (idx === wandSlot) idx++;
        if (idx >= container.size) {
            player.dimension.spawnItem(stack, player.location);
            overflow += stack.amount;
            continue;
        }
        container.setItem(idx, stack);
        idx++;
    }
    return overflow;
}

// ---------------------------------------------------------------------------
// Inventory toolbox: sort
// ---------------------------------------------------------------------------

function actionSortInventory(player) {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return;
    const { items, wandSlot } = snapshotInventory(container);

    let junkCount = 0;
    const kept = [];
    for (const item of items) {
        if (JUNK_IDS.has(item.typeId) && !item.nameTag) junkCount += item.amount;
        else kept.push(item);
    }

    const merged = mergeStacks(kept);

    const byCat = { tools: [], food: [], ores: [], blocks: [], misc: [] };
    for (const item of merged) byCat[categoryOf(item)].push(item);
    for (const list of Object.values(byCat)) {
        list.sort((a, b) => a.typeId.localeCompare(b.typeId) || b.amount - a.amount);
    }

    // Layout: tools/weapons fill from slot 0 (the hotbar), then blocks, ores
    // and misc; food is anchored to the bottom-right end of the inventory.
    const front = [...byCat.tools, ...byCat.blocks, ...byCat.ores, ...byCat.misc];
    const back = byCat.food;

    for (let i = 0; i < container.size; i++) {
        if (i === wandSlot) continue;
        container.setItem(i, undefined);
    }
    const used = new Set(wandSlot >= 0 ? [wandSlot] : []);
    let backIdx = container.size - 1;
    for (const item of back) {
        while (backIdx >= 0 && used.has(backIdx)) backIdx--;
        if (backIdx < 0) break;
        container.setItem(backIdx, item);
        used.add(backIdx);
    }
    let frontIdx = 0;
    for (const item of front) {
        while (used.has(frontIdx)) frontIdx++;
        if (frontIdx >= container.size) break;
        container.setItem(frontIdx, item);
        used.add(frontIdx);
    }

    let msg = `§a整理完成：${merged.length} 组物品（工具→方块→矿物→杂物，食物在末尾）。`;
    if (junkCount > 0) msg += ` §7丢弃垃圾 ${junkCount} 个。`;
    player.sendMessage(msg);
}

// ---------------------------------------------------------------------------
// Inventory toolbox: ore <-> block conversion (9:1 crafting pairs)
// ---------------------------------------------------------------------------

const COMPRESS_MAP = {
    "minecraft:coal": "minecraft:coal_block",
    "minecraft:raw_iron": "minecraft:raw_iron_block",
    "minecraft:iron_ingot": "minecraft:iron_block",
    "minecraft:raw_copper": "minecraft:raw_copper_block",
    "minecraft:copper_ingot": "minecraft:copper_block",
    "minecraft:raw_gold": "minecraft:raw_gold_block",
    "minecraft:gold_ingot": "minecraft:gold_block",
    "minecraft:diamond": "minecraft:diamond_block",
    "minecraft:emerald": "minecraft:emerald_block",
    "minecraft:lapis_lazuli": "minecraft:lapis_block",
    "minecraft:redstone": "minecraft:redstone_block",
    "minecraft:netherite_ingot": "minecraft:netherite_block",
};
const DECOMPRESS_MAP = Object.fromEntries(
    Object.entries(COMPRESS_MAP).map(([item, block]) => [block, item])
);

function actionConvert(player, mode) {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return;
    const map = mode === "compress" ? COMPRESS_MAP : DECOMPRESS_MAP;
    const { items, wandSlot } = snapshotInventory(container);

    const kept = [];
    const pool = new Map(); // source typeId -> total count
    for (const item of items) {
        // Renamed stacks are treated as special and never converted.
        if (map[item.typeId] && !item.nameTag) {
            pool.set(item.typeId, (pool.get(item.typeId) ?? 0) + item.amount);
        } else {
            kept.push(item);
        }
    }
    if (pool.size === 0) {
        player.sendMessage("§e背包里没有可转换的物品。");
        return;
    }

    let converted = 0;
    const out = [];
    for (const [srcId, count] of pool) {
        const dstId = map[srcId];
        if (mode === "compress") {
            const blocks = Math.floor(count / 9);
            const rest = count % 9;
            if (blocks > 0) {
                emitStacks(dstId, blocks, out);
                converted += blocks;
            }
            if (rest > 0) emitStacks(srcId, rest, out);
        } else {
            emitStacks(dstId, count * 9, out);
            converted += count;
        }
    }

    const overflow = writeBack(player, container, wandSlot, [...kept, ...out]);
    let msg = mode === "compress"
        ? `§a已合成 ${converted} 个矿物块，零头保留为原矿。`
        : `§a已拆解 ${converted} 个矿物块。`;
    if (overflow > 0) msg += ` §e背包放不下，${overflow} 个物品掉在了脚下。`;
    player.sendMessage(msg);
}

// ---------------------------------------------------------------------------
// Inventory toolbox: deposit into nearby chests
//
// Chests labeled with an adjacent sign reading "[storage]" + category receive
// matching items; unlabeled chests act like quick-stack (they only receive
// item types they already contain). Scan range: 6 blocks around the player.
// ---------------------------------------------------------------------------

const CONTAINER_TYPES = new Set([
    "minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel",
]);

const LABEL_ALIASES = {
    ores: ["ores", "ore", "矿物", "矿"],
    food: ["food", "食物"],
    tools: ["tools", "tool", "weapons", "weapon", "工具", "武器"],
    blocks: ["blocks", "block", "方块"],
    misc: ["misc", "other", "杂物", "其他"],
    all: ["all", "any", "全部"],
};

function categoryForLabel(label) {
    for (const [category, aliases] of Object.entries(LABEL_ALIASES)) {
        if (aliases.includes(label)) return category;
    }
    return undefined;
}

// A storage sign looks like:  [storage]  on line 1, category on line 2.
function parseStorageLabel(text) {
    const lines = String(text).split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l);
    if (lines.length < 2 || !lines[0].includes("[storage]")) return undefined;
    return lines[1];
}

function scanStorageTargets(player) {
    const dim = player.dimension;
    const base = {
        x: Math.floor(player.location.x),
        y: Math.floor(player.location.y),
        z: Math.floor(player.location.z),
    };
    const chests = [];
    const signs = [];
    for (let dx = -6; dx <= 6; dx++) {
        for (let dy = -2; dy <= 3; dy++) {
            for (let dz = -6; dz <= 6; dz++) {
                let block;
                try {
                    block = dim.getBlock({ x: base.x + dx, y: base.y + dy, z: base.z + dz });
                } catch {
                    continue; // outside world bounds
                }
                if (!block) continue;
                if (CONTAINER_TYPES.has(block.typeId)) {
                    const container = block.getComponent("minecraft:inventory")?.container;
                    if (container) chests.push({ location: block.location, container });
                } else if (block.typeId.includes("sign")) {
                    try {
                        const text = block.getComponent("minecraft:sign")?.getText();
                        const label = text ? parseStorageLabel(text) : undefined;
                        if (label) signs.push({ location: block.location, label });
                    } catch {
                        // Unreadable sign; ignore.
                    }
                }
            }
        }
    }

    // A sign directly adjacent to a chest (any face, including on top) labels it.
    const labeled = [];
    const unlabeled = [];
    for (const chest of chests) {
        const sign = signs.find((s) =>
            Math.abs(s.location.x - chest.location.x) +
            Math.abs(s.location.y - chest.location.y) +
            Math.abs(s.location.z - chest.location.z) === 1
        );
        const category = sign ? categoryForLabel(sign.label) : undefined;
        if (category) labeled.push({ ...chest, category });
        else unlabeled.push(chest);
    }
    return { labeled, unlabeled };
}

function actionDepositToChests(player) {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return;

    const { labeled, unlabeled } = scanStorageTargets(player);
    if (labeled.length + unlabeled.length === 0) {
        player.sendMessage("§e附近 6 格内没有找到箱子或木桶。");
        return;
    }

    // Snapshot which item types each unlabeled chest already holds BEFORE
    // moving anything, so items deposited during this pass cannot change the
    // quick-stack matching rules mid-run.
    for (const chest of unlabeled) {
        const types = new Set();
        for (let i = 0; i < chest.container.size; i++) {
            const it = chest.container.getItem(i);
            if (it) types.add(it.typeId);
        }
        chest.types = types;
    }

    let moved = 0;
    const usedChests = new Set();
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        if (!item || isWand(item)) continue;

        const before = item.amount;
        const cat = categoryOf(item);
        let remaining = item;
        for (const chest of labeled) {
            if (!remaining) break;
            if (chest.category !== "all" && chest.category !== cat) continue;
            remaining = chest.container.addItem(remaining);
            usedChests.add(chest);
        }
        for (const chest of unlabeled) {
            if (!remaining) break;
            if (!chest.types.has(remaining.typeId)) continue;
            remaining = chest.container.addItem(remaining);
            usedChests.add(chest);
        }

        const after = remaining?.amount ?? 0;
        if (after !== before) {
            container.setItem(i, remaining);
            moved += before - after;
        }
    }

    if (moved === 0) {
        player.sendMessage(
            "§e没有可存入的物品。§7提示：无标签箱子只收纳它已有的物品种类；" +
            "给箱子旁立一块告示牌写上 [storage] + 分类（如 ores）可指定收纳类别。"
        );
    } else {
        player.sendMessage(`§a已将 ${moved} 个物品存入 ${usedChests.size} 个容器。`);
    }
}

// ---------------------------------------------------------------------------
// Inventory toolbox: submenu
// ---------------------------------------------------------------------------

const STORAGE_MENU_ACTIONS = [
    { label: "一键整理\n§7合并同类、分类排列、丢弃垃圾", handler: actionSortInventory },
    { label: "矿物合成块\n§7铁锭×9 → 铁块（零头保留）", handler: (p) => actionConvert(p, "compress") },
    { label: "矿物块拆解\n§7铁块 → 铁锭×9", handler: (p) => actionConvert(p, "expand") },
    { label: "存入附近箱子\n§7按告示牌 [storage] 标签分类存储", handler: actionDepositToChests },
];

function openStorageMenu(player) {
    const form = new ActionFormData()
        .title("§l背包整理")
        .body("选择一个功能：");
    for (const action of STORAGE_MENU_ACTIONS) {
        form.button(action.label);
    }
    form.show(player).then((response) => {
        if (response.canceled) return;
        const action = STORAGE_MENU_ACTIONS[response.selection];
        if (!action) return;
        try {
            action.handler(player);
        } catch (e) {
            player.sendMessage(`§c[权杖] 执行出错: ${e}\n${e?.stack ?? ""}`);
        }
    });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

const MENU_ACTIONS = [
    { label: "一键满附魔 »\n§7全部附满，或挑一件附魔", handler: openEnchantMenu },
    { label: "整理背包 »\n§7排序、矿物转换、存入箱子", handler: openStorageMenu },
    { label: "清理背包\n§7清空背包（保留权杖和盔甲）", handler: actionClearInventory },
    { label: "切换白天/黑夜\n§7在白天和黑夜之间切换", handler: actionToggleDayNight },
    { label: "设置当前位置为家\n§7记住脚下这个位置", handler: actionSetHome },
    { label: "返回家\n§7传送回已设置的家", handler: actionGoHome },
];

function openMenu(player) {
    const form = new ActionFormData()
        .title("§l管理员权杖")
        .body("选择一个功能：");
    for (const action of MENU_ACTIONS) {
        form.button(action.label);
    }

    form.show(player).then((response) => {
        if (response.canceled) return;
        const action = MENU_ACTIONS[response.selection];
        if (!action) return;
        try {
            action.handler(player);
        } catch (e) {
            player.sendMessage(`§c[权杖] 执行出错: ${e}\n${e?.stack ?? ""}`);
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
// Getting the wand: /scriptevent wand:give
// ---------------------------------------------------------------------------

function giveWand(player) {
    const wand = new ItemStack(WAND_TYPE, 1);
    wand.nameTag = WAND_NAME;
    wand.setLore(["§7长按（使用）打开管理员菜单"]);
    const container = player.getComponent("minecraft:inventory")?.container;
    const leftover = container?.addItem(wand);
    if (leftover) {
        player.sendMessage("§e背包已满，无法给予权杖。");
    } else {
        player.sendMessage("§a已获得 §b管理员权杖§a！手持并长按（使用）即可打开菜单。");
    }
}

system.afterEvents.scriptEventReceive.subscribe((event) => {
    if (event.id !== "wand:give") return;
    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;
    giveWand(player);
});

// Startup banner so it is easy to confirm which script version actually loaded.
console.warn(`[AdminWand] script v${VERSION} loaded`);
world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    system.runTimeout(() => {
        event.player.sendMessage(
            `§b[管理员权杖 v${VERSION}] 已加载：输入 /scriptevent wand:give 获取权杖`
        );
    }, 40);
});
