import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";

const VERSION = "1.0";

// The wand is a renamed vanilla nether star, so no resource pack is needed
// (blaze rod and breeze rod are taken by the other wand packs).
// Both the type id and the display name must match for the menu to open.
const WAND_TYPE = "minecraft:nether_star";
const WAND_NAME = "§r§c召唤权杖";

// Every entity this wand spawns gets this tag, so "clear summoned bosses"
// only ever touches mobs the wand itself created — never naturally spawned
// ones or anything from other packs.
const SUMMON_TAG = "bosswand_summoned";

// confirm: dangerous bosses pop a yes/no dialog before spawning.
// yOffset: extra height above the spawn point (flying bosses).
const BOSSES = [
    {
        typeId: "minecraft:wither",
        label: "凋灵\n§7召唤时会爆炸，注意远离",
        name: "凋灵",
        confirm: "凋灵生成时会§c爆炸§r并摧毁周围方块，确定在这里召唤吗？",
        yOffset: 2,
    },
    {
        typeId: "minecraft:ender_dragon",
        label: "末影龙\n§7会飞走并破坏沿途方块",
        name: "末影龙",
        confirm: "末影龙会在附近飞行并§c破坏沿途方块§r（无法穿过的方块除外），确定召唤吗？",
        yOffset: 8,
    },
    {
        typeId: "minecraft:warden",
        label: "监守者\n§7近战一击重伤，远程音波攻击",
        name: "监守者",
        confirm: "监守者伤害极高且会主动追击，确定在这里召唤吗？",
    },
    {
        typeId: "minecraft:elder_guardian",
        label: "远古守卫者\n§7激光攻击，会施加挖掘疲劳",
        name: "远古守卫者",
    },
    {
        typeId: "minecraft:ravager",
        label: "劫掠兽\n§7冲撞攻击，会踩坏庄稼",
        name: "劫掠兽",
    },
    {
        typeId: "minecraft:evoker",
        label: "唤魔者\n§7召唤尖牙和恼鬼，掉落不死图腾",
        name: "唤魔者",
    },
];

function isWand(item) {
    return item?.typeId === WAND_TYPE && item?.nameTag === WAND_NAME;
}

// ---------------------------------------------------------------------------
// Summoning
// ---------------------------------------------------------------------------

// Spawn point: a few blocks ahead of the player on the horizontal plane, at
// the player's own height (plus the boss's yOffset). Looking straight up or
// down leaves no horizontal direction, so fall back to "right in front" +x.
function summonLocation(player, yOffset = 0) {
    const dir = player.getViewDirection();
    const len = Math.hypot(dir.x, dir.z);
    const distance = 6;
    const nx = len > 0.01 ? dir.x / len : 1;
    const nz = len > 0.01 ? dir.z / len : 0;
    return {
        x: player.location.x + nx * distance,
        y: player.location.y + yOffset,
        z: player.location.z + nz * distance,
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
        player.sendMessage(`§c[召唤权杖] 召唤失败: ${e}`);
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
    form.show(player).then((response) => {
        if (response.canceled || response.selection !== 0) return;
        summonBoss(player, boss);
    });
}

// ---------------------------------------------------------------------------
// Cleanup: remove every entity this wand has summoned in the player's
// current dimension (identified by SUMMON_TAG).
// ---------------------------------------------------------------------------

function actionClearSummoned(player) {
    let entities = [];
    try {
        entities = player.dimension.getEntities({ tags: [SUMMON_TAG] });
    } catch (e) {
        player.sendMessage(`§c[召唤权杖] 查询失败: ${e}`);
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
// Main menu
// ---------------------------------------------------------------------------

function openMenu(player) {
    const form = new ActionFormData()
        .title("§l召唤权杖")
        .body("Boss 会出现在你§c面前 6 格§r处。\n选择要召唤的 Boss：");
    for (const boss of BOSSES) {
        form.button(boss.label);
    }
    form.button("§4清除已召唤的 Boss\n§7移除当前维度里本权杖召唤的全部 Boss");

    form.show(player).then((response) => {
        if (response.canceled) return;
        try {
            if (response.selection === BOSSES.length) {
                actionClearSummoned(player);
                return;
            }
            const boss = BOSSES[response.selection];
            if (boss) actionSummon(player, boss);
        } catch (e) {
            player.sendMessage(`§c[召唤权杖] 执行出错: ${e}\n${e?.stack ?? ""}`);
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
// Getting the wand: /scriptevent boss:give
// ---------------------------------------------------------------------------

function giveWand(player) {
    const wand = new ItemStack(WAND_TYPE, 1);
    wand.nameTag = WAND_NAME;
    wand.setLore(["§7长按（使用）召唤 Boss"]);
    const container = player.getComponent("minecraft:inventory")?.container;
    const leftover = container?.addItem(wand);
    if (leftover) {
        player.sendMessage("§e背包已满，无法给予权杖。");
    } else {
        player.sendMessage("§a已获得 §c召唤权杖§a！手持并长按（使用）即可打开菜单。");
    }
}

system.afterEvents.scriptEventReceive.subscribe((event) => {
    if (event.id !== "boss:give") return;
    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;
    giveWand(player);
});

// Startup banner so it is easy to confirm which script version actually loaded.
console.warn(`[BossWand] script v${VERSION} loaded`);
world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    system.runTimeout(() => {
        event.player.sendMessage(
            `§c[召唤权杖 v${VERSION}] 已加载：输入 /scriptevent boss:give 获取权杖`
        );
    }, 40);
});
