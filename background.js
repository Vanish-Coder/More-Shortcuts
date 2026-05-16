// More Shortcuts - Background Service Worker

const DEFAULT_STATE = {
  shortcuts: {
    "collapse-group-pause-media": true,
    "new-tab-in-group": true,
    "random-site": true
  },
  randomSites: [
    "https://news.ycombinator.com",
    "https://reddit.com",
    "https://github.com/trending"
  ]
};

// Track which tabs we muted, keyed by groupId
// { groupId: [tabId, tabId, ...] }
const mutedTabsByGroup = {};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (existing) => {
    if (!existing.shortcuts) {
      chrome.storage.sync.set({ shortcuts: DEFAULT_STATE.shortcuts });
    }
    if (!existing.randomSites) {
      chrome.storage.sync.set({ randomSites: DEFAULT_STATE.randomSites });
    }
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const data = await chrome.storage.sync.get(["shortcuts", "randomSites"]);
  const shortcuts = data.shortcuts || DEFAULT_STATE.shortcuts;
  const randomSites = data.randomSites || DEFAULT_STATE.randomSites;

  if (!shortcuts[command]) return;

  if (command === "collapse-group-pause-media") {
    await handleCollapseAndPause();
  } else if (command === "new-tab-in-group") {
    await handleNewTabInGroup();
  } else if (command === "random-site") {
    await handleRandomSite(randomSites);
  }
});

// ── When user activates a tab, unmute its group if we muted it ─────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groupId = tab.groupId;
    if (!groupId || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
    if (!mutedTabsByGroup[groupId]) return;

    // User clicked into this group — unmute all tabs we muted for it
    const tabsToUnmute = mutedTabsByGroup[groupId];
    for (const id of tabsToUnmute) {
      try { await chrome.tabs.update(id, { muted: false }); } catch (e) { /* tab may be gone */ }
    }
    delete mutedTabsByGroup[groupId];
  } catch (e) { /* ignore */ }
});

// ── Shortcut 1: Collapse active tab's group + pause/mute media ─────────────
async function handleCollapseAndPause() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) return;

  const groupId = activeTab.groupId;
  const inGroup = groupId && groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;

  const tabsToPause = inGroup
    ? await chrome.tabs.query({ groupId, windowId: activeTab.windowId })
    : [activeTab];

  const mutedIds = [];
  for (const tab of tabsToPause) {
    const wasMuted = await pauseTabMedia(tab);
    if (wasMuted) mutedIds.push(tab.id);
  }

  // Remember which tabs we muted so we can unmute later
  if (inGroup && mutedIds.length > 0) {
    mutedTabsByGroup[groupId] = mutedIds;
  }

  if (!inGroup) return;

  // Find closest tab outside the group to escape to
  const allTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
  const outside = allTabs.filter(t => t.groupId !== groupId);

  let target = null;
  if (outside.length > 0) {
    const before = outside.filter(t => t.index < activeTab.index);
    const after  = outside.filter(t => t.index > activeTab.index);
    target = before.length > 0
      ? before[before.length - 1]
      : after.length > 0
        ? after[0]
        : outside[0];
  }

  // Collapse the group
  try {
    await chrome.tabGroups.update(groupId, { collapsed: true });
  } catch (e) {
    console.warn("Could not collapse group:", e);
  }

  // Navigate to escape tab
  if (target) {
    await chrome.tabs.update(target.id, { active: true });
  }
}

// ── Shortcut 2: Open new tab in its own new group ──────────────────────────
async function handleNewTabInGroup() {
  const newTab = await chrome.tabs.create({ active: true });
  try {
    const groupId = await chrome.tabs.group({ tabIds: [newTab.id] });
    await chrome.tabGroups.update(groupId, { title: "", color: "blue" });
  } catch (e) {
    console.warn("Could not create group:", e);
  }
}

// ── Shortcut 3: Open random site from user's list ─────────────────────────
async function handleRandomSite(sites) {
  if (!sites || sites.length === 0) return;
  const url = sites[Math.floor(Math.random() * sites.length)];
  await chrome.tabs.create({ url, active: true });
}

// ── Pause/mute a tab — returns true if we muted it (so we can unmute later)
async function pauseTabMedia(tab) {
  const isYouTube = tab.url && tab.url.includes("youtube.com");

  if (isYouTube) {
    // YouTube: actually pause the video via content script
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "PAUSE_MEDIA" });
    } catch (e) { /* ignore */ }
    return false; // not muted, no need to unmute
  } else {
    // Everything else: mute at browser level
    try {
      await chrome.tabs.update(tab.id, { muted: true });
      return true; // we muted it, needs unmuting later
    } catch (e) {
      return false;
    }
  }
}
