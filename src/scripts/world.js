// World-level conveniences: time of day and a personal home point.

import { world } from "@minecraft/server";

const HOME_PROPERTY = "wand:home";

// Night runs from 13000 to 23000; anything else counts as day.
const NIGHT_START = 13000;
const NIGHT_END = 23000;

export function actionToggleDayNight(player) {
    const time = world.getTimeOfDay();
    if (time >= NIGHT_START && time < NIGHT_END) {
        world.setTimeOfDay(1000);
        player.sendMessage("§e已切换到白天 ☀");
    } else {
        world.setTimeOfDay(NIGHT_START);
        player.sendMessage("§9已切换到黑夜 ☽");
    }
}

// Home is stored per player as a dynamic property, so it survives relogging
// and world reloads, and each player keeps their own.
export function actionSetHome(player) {
    const home = {
        x: Math.floor(player.location.x),
        y: Math.floor(player.location.y),
        z: Math.floor(player.location.z),
        dimension: player.dimension.id,
    };
    player.setDynamicProperty(HOME_PROPERTY, JSON.stringify(home));
    player.sendMessage(`§a家已设置在 §f(${home.x}, ${home.y}, ${home.z})§a，维度：${home.dimension}`);
}

export function actionGoHome(player) {
    const raw = player.getDynamicProperty(HOME_PROPERTY);
    if (typeof raw !== "string") {
        player.sendMessage("§e还没有设置过家，请先使用【设置当前位置为家】。");
        return;
    }
    try {
        const home = JSON.parse(raw);
        const dimension = world.getDimension(home.dimension);
        // +0.5 centers the player on the block instead of on its corner.
        player.teleport({ x: home.x + 0.5, y: home.y, z: home.z + 0.5 }, { dimension });
        player.sendMessage(`§a已返回家 §f(${home.x}, ${home.y}, ${home.z})`);
    } catch (e) {
        player.sendMessage(`§c传送失败: ${e}`);
    }
}
