// Inventory toolbox: sorting, ore <-> block conversion, depositing into
// nearby chests, and clearing the pack.

import { ItemStack } from "@minecraft/server";
import * as mc from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";
import { isWand, showForm, showActionMenu } from "./core.js";

// ---------------------------------------------------------------------------
// Categorization rules
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
// Snapshot helpers
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
// Sort
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

    // Merging can only ever reduce the stack count, so everything is expected
    // to fit. Spill anything left over at the player's feet anyway, rather
    // than silently destroying it the way a bare `break` would.
    const used = new Set(wandSlot >= 0 ? [wandSlot] : []);
    let overflow = 0;
    const place = (item, nextFreeSlot) => {
        const slot = nextFreeSlot();
        if (slot === undefined) {
            player.dimension.spawnItem(item, player.location);
            overflow += item.amount;
            return;
        }
        container.setItem(slot, item);
        used.add(slot);
    };

    let backIdx = container.size - 1;
    for (const item of back) {
        place(item, () => {
            while (backIdx >= 0 && used.has(backIdx)) backIdx--;
            return backIdx >= 0 ? backIdx : undefined;
        });
    }
    let frontIdx = 0;
    for (const item of front) {
        place(item, () => {
            while (frontIdx < container.size && used.has(frontIdx)) frontIdx++;
            return frontIdx < container.size ? frontIdx : undefined;
        });
    }

    let msg = `§a整理完成：${merged.length} 组物品（工具→方块→矿物→杂物，食物在末尾）。`;
    if (junkCount > 0) msg += ` §7丢弃垃圾 ${junkCount} 个。`;
    if (overflow > 0) msg += ` §e背包放不下，${overflow} 个物品掉在了脚下。`;
    player.sendMessage(msg);
}

// ---------------------------------------------------------------------------
// Ore <-> block conversion (9:1 crafting pairs)
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
// Deposit into nearby chests
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

// Both halves of a double chest expose the SAME 54-slot container, so naively
// collecting every chest block counts one double chest twice. A paired chest
// is recognisable by its doubled container size plus a horizontally adjacent
// block of the same type — two unpaired single chests both report 27 slots,
// so they are never merged by mistake.
const SINGLE_CHEST_SIZE = 27;

function isSecondHalfOfDoubleChest(block, container, chests) {
    if (container.size <= SINGLE_CHEST_SIZE) return false;
    return chests.some(
        (other) =>
            other.typeId === block.typeId &&
            other.container.size === container.size &&
            other.location.y === block.location.y &&
            Math.abs(other.location.x - block.location.x) +
                Math.abs(other.location.z - block.location.z) === 1
    );
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
                    if (container && !isSecondHalfOfDoubleChest(block, container, chests)) {
                        chests.push({
                            typeId: block.typeId,
                            location: block.location,
                            container,
                        });
                    }
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
// Clear inventory (keeps the wand itself and worn armor)
// ---------------------------------------------------------------------------

function actionClearInventory(player) {
    const confirm = new MessageFormData()
        .title("清空背包")
        .body("确定要清空背包吗？\n§7权杖本身和身上穿的盔甲会保留。§r\n\n§c此操作无法撤销！")
        .button1("§c确认清空")
        .button2("取消");

    showForm(player, confirm, (response) => {
        if (response.selection !== 0) return;

        const container = player.getComponent("minecraft:inventory")?.container;
        if (!container) return;

        let cleared = 0;
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (!item || isWand(item)) continue;
            container.setItem(i, undefined);
            cleared++;
        }
        player.sendMessage(`§a背包已清空，共移除 ${cleared} 组物品。`);
    });
}

// ---------------------------------------------------------------------------
// Submenu
// ---------------------------------------------------------------------------

const INVENTORY_MENU_ACTIONS = [
    { label: "一键整理\n§7合并同类、分类排列、丢弃垃圾", handler: actionSortInventory },
    { label: "矿物合成块\n§7铁锭×9 → 铁块（零头保留）", handler: (p) => actionConvert(p, "compress") },
    { label: "矿物块拆解\n§7铁块 → 铁锭×9", handler: (p) => actionConvert(p, "expand") },
    { label: "存入附近箱子\n§7按告示牌 [storage] 标签分类存储", handler: actionDepositToChests },
    { label: "§c清空背包\n§7保留权杖和身上的盔甲", handler: actionClearInventory },
];

export function openInventoryMenu(player) {
    showActionMenu(player, {
        form: new ActionFormData().title("§l背包整理").body("选择一个功能："),
        actions: INVENTORY_MENU_ACTIONS,
    });
}
