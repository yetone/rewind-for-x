# Chrome Web Store listing: Rewind for X

Upload `dist/rewind-for-x-<version>.zip` (built by `tools/pack.sh`).
The name and short description come from `_locales/*/messages.json`.

## Store listing tab

- **Category**: Social & Communication → Social Networking (or "Tools")
- **Language**: English (default), plus Chinese (Simplified)
- **Screenshots** (1280×800): `store/screenshots/en-*.png`; for the Chinese listing, `zh_CN-*.png`
- **Small promo tile** (440×280): `store/promo/en-small-440x280.png` / `zh_CN-small-440x280.png`
- **Marquee promo tile** (1400×560, optional): `store/promo/en-marquee-1400x560.png` / `zh_CN-marquee-1400x560.png`
- **Icon**: in the package (`icons/128.png`)

### Detailed description: English

```
X's home timeline refreshes often, and a good post you were halfway through can vanish under a wave of new ones. Rewind for X quietly keeps the posts you've seen on Home so you can find them again.

• A post counts as seen once at least half of it has been on screen. The author, text, images, quoted post, who reposted it and the link are kept.
• Open the drawer with the button above X's own floating buttons, the toolbar icon, or Alt+Shift+R. Posts are listed newest first and grouped by when you saw them.
• Search by author, @handle or any word in the post.
• Turn on Search text in images to find posts by the words in their screenshots and memes too. The text is read on your device; the first time, a few MB of recognition data for your language is downloaded.
• Click a post to open it on X in a new tab.
• Follows X's light, dim and dark themes.
• Ads are skipped. Only the Home timeline is recorded; profiles, threads and search are not.

Private by design: everything stays in your browser's local storage on this device. Nothing is uploaded, synced or shared, there are no accounts and no analytics. The newest 3,000 posts are kept, and one click (confirmed by a second) clears them all.

Rewind for X is an independent project. It is not made, endorsed or sponsored by X Corp.
```

### Detailed description: 简体中文

```
X 的首页推荐刷新很频繁，看到一半的好帖子一转眼就被新内容顶掉了。Rewind for X 会默默记下你在首页看到过的推文，让你随时找回来。

• 推文在屏幕上露出一半以上就算"看过"，记下作者、正文、图片、引用推文、转帖人和链接。
• 点 X 悬浮按钮上方的回看按钮、工具栏图标或按 Alt+Shift+R 打开侧栏。按时间倒序列出，并按看到的时间分组。
• 可以按作者、@用户名或正文里的任意词搜索。
• 打开“搜索图中文字”，还能按截图、梗图里的文字找到推文。文字在本机识别；第一次使用会下载几 MB 对应语言的识别数据。
• 点一条推文，在新标签页里打开原帖。
• 跟随 X 的浅色、暗蓝和纯黑主题。
• 自动跳过广告。只记录首页推荐，个人主页、对话串和搜索页不记录。

隐私优先：所有数据只保存在本机浏览器的本地存储里，不上传、不同步、不分享，没有账号，也没有任何统计。最多保留最近 3000 条，点一下清空按钮（再点一次确认）即可全部删除。

Rewind for X 是独立开发的项目，并非 X Corp. 的官方产品，也未获其认可或赞助。
```

## Privacy practices tab

### Single purpose

```
Rewind for X keeps a local list of the posts the user has seen on their X (x.com) home timeline, so they can find and reopen posts that the timeline replaced.
```

### Permission justification: storage

```
Used to save the list of posts the user has seen on their X home timeline (author, text, image URLs, link and time) in chrome.storage.local on the user's device, so the list survives page reloads and browser restarts. The data never leaves the device.
```

### Host permission justification: https://x.com/*, https://twitter.com/*

```
The content script runs only on x.com (and twitter.com, which redirects to it). It reads the posts shown on the home timeline to record which ones the user has seen, and draws the drawer that lists them. It does not run on any other site and makes no network requests.
```

### Remote code

```
No, I am not using remote code. All JavaScript is included in the package.
```

### Data usage

Tick only:

- [x] **Website content** (the text, images and links of posts the user has seen on x.com)

Leave the rest unticked: personally identifiable information, health, financial and payment, authentication, personal communications, location, web history, user activity.

Then tick all three certifications:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

```
https://rewindforx.com/privacy/
```
