// Boss summoning, plus a cleanup that only ever touches what the wand spawned.

import { ActionFormData, MessageFormData } from "@minecraft/server-ui";
import { showForm, showActionMenu } from "./core.js";

// Every entity summoned here gets this tag, so "clear summoned bosses" never
// touches naturally spawned mobs or anything from another pack.
const SUMMON_TAG = "wand_summoned";

// How far in front of the player a boss appears.
const SUMMON_DISTANCE = 6;

// confirm: dangerous bosses pop a yes/no dialog before spawning.
// yOffset: extra height above the spawn point (flying bosses).
const BOSSES = [
    {
        typeId: "minecraft:wither",
        name: "凋灵",
        hint: "召唤时会爆炸，注意远离",
        confirm: "凋灵生成时会§c爆炸§r并摧毁周围方块，确定在这里召唤吗？",
        yOffset: 2,
    },
    {
        typeId: "minecraft:ender_dragon",
        name: "末影龙",
        hint: "会飞走并破坏沿途方块",
        confirm: "末影龙会在附近飞行并§c破坏沿途方块§r（无法穿过的方块除外），确定召唤吗？",
        yOffset: 8,
    },
    {
        typeId: "minecraft:warden",
        name: "监守者",
        hint: "近战一击重伤，远程音波攻击",
        confirm: "监守者伤害极高且会主动追击，确定在这里召唤吗？",
    },
    {
        typeId: "minecraft:elder_guardian",
        name: "远古守卫者",
        hint: "激光攻击，会施加挖掘疲劳",
    },
    {
        typeId: "minecraft:ravager",
        name: "劫掠兽",
        hint: "冲撞攻击，会踩坏庄稼",
    },
    {
        // Bedrock keeps the legacy id; "minecraft:evoker" is Java-only.
        typeId: "minecraft:evocation_illager",
        name: "唤魔者",
        hint: "召唤尖牙和恼鬼，掉落不死图腾",
    },
];

// ---------------------------------------------------------------------------
// Summoning
// ---------------------------------------------------------------------------

// Spawn point: a few blocks ahead of the player on the horizontal plane, at
// the player's own height (plus the boss's yOffset). Looking straight up or
// down leaves no horizontal direction, so fall back to "right in front" +x.
function summonLocation(player, yOffset = 0) {
    const dir = player.getViewDirection();
    const len = Math.hypot(dir.x, dir.z);
    const nx = len > 0.01 ? dir.x / len : 1;
    const nz = len > 0.01 ? dir.z / len : 0;
    return {
        x: player.location.x + nx * SUMMON_DISTANCE,
        y: player.location.y + yOffset,
        z: player.location.z + nz * SUMMON_DISTANCE,
    };
}

function summonBoss(player, boss) {
    try {
        const entity = player.dimension.spawnEntity(
            boss.typeId,
            summonLocation(player, boss.yOffset ?? 0)
        );
        entity.addTag(SUMMON_TAG);
        player.sendMessage(`§c${boss.name}§a 已在你面前召唤，祝你好运！`);
    } catch (e) {
        player.sendMessage(`§c召唤失败: ${e}`);
    }
}

function actionSummon(player, boss) {
    if (!boss.confirm) {
        summonBoss(player, boss);
        return;
    }
    const form = new MessageFormData()
        .title(`召唤${boss.name}`)
        .body(`${boss.confirm}\n\n§7（可用菜单里的【清除已召唤的 Boss】收场）`)
        .button1("§c确认召唤")
        .button2("取消");
    showForm(player, form, (response) => {
        if (response.selection !== 0) return;
        summonBoss(player, boss);
    });
}

// ---------------------------------------------------------------------------
// Cleanup: remove every entity the wand has summoned in the player's
// current dimension (identified by SUMMON_TAG).
// ---------------------------------------------------------------------------

function actionClearSummoned(player) {
    let entities = [];
    try {
        entities = player.dimension.getEntities({ tags: [SUMMON_TAG] });
    } catch (e) {
        player.sendMessage(`§c查询失败: ${e}`);
        return;
    }
    if (entities.length === 0) {
        player.sendMessage("§e当前维度没有本权杖召唤的 Boss。");
        return;
    }
    let cleared = 0;
    for (const entity of entities) {
        try {
            // remove() despawns silently (no death animation / drops);
            // fall back to kill() on API versions where it is unavailable.
            if (typeof entity.remove === "function") entity.remove();
            else entity.kill();
            cleared++;
        } catch {
            // Already gone or not removable; ignore.
        }
    }
    player.sendMessage(`§a已清除 ${cleared} 只召唤的 Boss。`);
}

// ---------------------------------------------------------------------------
// Submenu
// ---------------------------------------------------------------------------

const BOSS_MENU_ACTIONS = [
    ...BOSSES.map((boss) => ({
        label: `${boss.name}\n§7${boss.hint}`,
        handler: (player) => actionSummon(player, boss),
    })),
    {
        label: "§4清除已召唤的 Boss\n§7移除当前维度里本权杖召唤的全部 Boss",
        handler: actionClearSummoned,
    },
];

export function openBossMenu(player) {
    showActionMenu(player, {
        form: new ActionFormData()
            .title("§l召唤 Boss")
            .body(`Boss 会出现在你§c面前 ${SUMMON_DISTANCE} 格§r处。\n选择要召唤的 Boss：`),
        actions: BOSS_MENU_ACTIONS,
    });
}
