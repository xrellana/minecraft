// Entry point: the root menu, plus the event wiring in core.js.
//
// Each feature area lives in its own module and exposes a single
// open*Menu(player) or action*(player) function.

import { ActionFormData } from "@minecraft/server-ui";
import { registerWand, showActionMenu } from "./core.js";
import { openEnchantMenu } from "./enchant.js";
import { openInventoryMenu } from "./inventory.js";
import { openBuffMenu } from "./buffs.js";
import { openBossMenu } from "./bosses.js";
import { actionToggleDayNight, actionSetHome, actionGoHome } from "./world.js";

const MENU_ACTIONS = [
    { label: "一键满附魔 »\n§7全部附满，或挑一件附魔", handler: openEnchantMenu },
    { label: "整理背包 »\n§7排序、矿物转换、存箱子、清空", handler: openInventoryMenu },
    { label: "常驻 Buff »\n§7自动续杯的状态效果，含整活模式", handler: openBuffMenu },
    { label: "召唤 Boss »\n§7在面前召唤，也能一键清场", handler: openBossMenu },
    { label: "切换白天/黑夜\n§7在白天和黑夜之间切换", handler: actionToggleDayNight },
    { label: "设置当前位置为家\n§7记住脚下这个位置", handler: actionSetHome },
    { label: "返回家\n§7传送回已设置的家", handler: actionGoHome },
];

function openMenu(player) {
    showActionMenu(player, {
        form: new ActionFormData().title("§l万能权杖").body("选择一个功能："),
        actions: MENU_ACTIONS,
    });
}

registerWand(openMenu);
