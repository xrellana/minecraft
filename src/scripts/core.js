// Shared plumbing: the wand item itself, form helpers, and event wiring.
// Everything here is pack-wide; feature modules import from it.

import { world, system, ItemStack } from "@minecraft/server";

// Replaced by tools/build.mjs with the version from manifest.json, so the
// version number is written exactly once. The literal placeholder is what
// ships in src/, keeping this file valid JavaScript for editors.
export const VERSION = "__PACK_VERSION__";

const COLOR = "§b";
const DISPLAY_NAME = "万能权杖";

export const WAND = {
    // The wand is a renamed vanilla blaze rod, so no resource pack is needed.
    // Both the type id and the display name must match for the menu to open,
    // which is also why renaming it in an anvil breaks it.
    itemType: "minecraft:blaze_rod",
    nameTag: `§r${COLOR}${DISPLAY_NAME}`,
    displayName: DISPLAY_NAME,
    color: COLOR,
    lore: "§7长按（使用）打开权杖菜单",
    giveEvent: "wand:give",
};

export function isWand(item) {
    return item?.typeId === WAND.itemType && item?.nameTag === WAND.nameTag;
}

/** Uniform error report, so a thrown handler never fails silently. */
export function reportError(player, error) {
    player.sendMessage(
        `§c[${WAND.displayName}] 执行出错: ${error}\n${error?.stack ?? ""}`
    );
}

/**
 * Show a form and run `handler(response)` inside a try/catch. Every menu goes
 * through here, so a mistake in one action reports itself in chat instead of
 * disappearing into an unhandled promise rejection.
 */
export function showForm(player, form, handler) {
    form.show(player).then(
        (response) => {
            if (response.canceled) return;
            try {
                handler(response);
            } catch (e) {
                reportError(player, e);
            }
        },
        (e) => reportError(player, e)
    );
}

/**
 * Show an ActionFormData whose buttons come from `actions`, then dispatch to
 * the selected entry's handler.
 *
 * @param {object} options
 * @param {import("@minecraft/server-ui").ActionFormData} options.form
 *   A form with its title and body already set.
 * @param {{ label: string, handler: (player) => void }[]} options.actions
 */
export function showActionMenu(player, { form, actions }) {
    for (const action of actions) form.button(action.label);
    showForm(player, form, (response) => {
        const action = actions[response.selection];
        if (action) action.handler(player);
    });
}

function giveWand(player) {
    const wand = new ItemStack(WAND.itemType, 1);
    wand.nameTag = WAND.nameTag;
    wand.setLore([WAND.lore]);
    const container = player.getComponent("minecraft:inventory")?.container;
    const leftover = container?.addItem(wand);
    if (leftover) {
        player.sendMessage("§e背包已满，无法给予权杖。");
    } else {
        player.sendMessage(
            `§a已获得 ${WAND.color}${WAND.displayName}§a！手持并长按（使用）即可打开菜单。`
        );
    }
}

/**
 * Wire up everything the pack needs: opening the root menu on use, handing
 * out the wand via /scriptevent, and the load banner.
 *
 * @param {(player: import("@minecraft/server").Player) => void} openRootMenu
 */
export function registerWand(openRootMenu) {
    world.afterEvents.itemUse.subscribe((event) => {
        if (!isWand(event.itemStack)) return;
        const player = event.source;
        if (player?.typeId !== "minecraft:player") return;
        // Defer one tick so the form is not dismissed as "UserBusy" while the
        // use animation is still in progress.
        system.run(() => {
            try {
                openRootMenu(player);
            } catch (e) {
                reportError(player, e);
            }
        });
    });

    // Filtering by namespace means the pack is not woken for every unrelated
    // /scriptevent in the world.
    const namespace = WAND.giveEvent.split(":")[0];
    system.afterEvents.scriptEventReceive.subscribe(
        (event) => {
            if (event.id !== WAND.giveEvent) return;
            const player = event.sourceEntity;
            if (player?.typeId !== "minecraft:player") return;
            giveWand(player);
        },
        { namespaces: [namespace] }
    );

    // Startup banner, so it is easy to confirm which build actually loaded.
    console.warn(`[WandToolkit] script v${VERSION} loaded`);
    world.afterEvents.playerSpawn.subscribe((event) => {
        if (!event.initialSpawn) return;
        system.runTimeout(() => {
            event.player.sendMessage(
                `${WAND.color}[${WAND.displayName} v${VERSION}] 已加载：` +
                `输入 /scriptevent ${WAND.giveEvent} 获取权杖`
            );
        }, 40);
    });
}
