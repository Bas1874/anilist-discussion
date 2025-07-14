# Anilist Discussions for Seanime

<img src="https://raw.githubusercontent.com/Bas1874/anilist-discussion/main/src/Icons/ad-Icon.png" alt="Anilist Discussions Icon" width="200"/>

Bring AniList forum discussions directly into your Seanime experience. 
This plugin adds a dedicated tray icon that opens a fully-featured discussion panel, allowing you to read, post, and interact with the AniList community without ever leaving the app.

---

## ✨ Features

*   **Integrated Discussion Tray**: Access all discussion features from a convenient, collapsible tray panel.
*   **Context-Aware Thread Loading**: The plugin automatically fetches and displays discussion threads relevant to the anime you are currently viewing.
*   **Smart Thread Sorting**: Episode-specific discussions are automatically separated from general threads and sorted chronologically for easy navigation.
*   **Full Comment and Reply Chains**: View nested comments and replies, preserving the conversational structure of the forums.
*   **Complete Markdown Rendering**: Comments are rendered with full AniList-supported markdown, including:
    *   **Text styles**: Bold, Italic, Strikethrough
    *   **Block elements**: Headings, Blockquotes, Code Blocks, and Spoilers.
*   **Rich Text Editor**: A toolbar is included in the comment, reply, and edit boxes with buttons to easily insert markdown syntax for formatting your text.
*   **Interactive Commenting**:
    *   Like comments.
    *   Post new comments to a thread.
    *   Reply directly to other users' comments.
    *   Edit and delete your own comments.

## 📺 Showcase

![Showcase 1](https://raw.githubusercontent.com/Bas1874/anilist-discussion/main/src/Gifs/Showcase1.gif)

## ⚙️ Installation

Use the Seanime Marketplace for the easiest installation.

Manual Install
1.  Navigate to **Settings** > **Extensions** in your Seanime application.
2.  Click on the **Add Extension** button.
3.  In the input field, paste the following manifest URL:
    ```
    https://raw.githubusercontent.com/Bas1874/anilist-discussion/main/src/manifest.json
    ```
4.  Click **Submit**. The plugin will be installed.
5.  After installation, Seanime will prompt you to grant the necessary permissions. Please review and accept them for the plugin to function correctly.

## ⚠️ Known Issues

> **Image Rendering in Web Browsers**
>
> Due to browser security policies (Cross-Origin Resource Sharing), most images embedded in comments will not load when using Seanime in a web browser.
>
> *   **Workaround**: For every image, a fallback "Open Link" button is provided. Clicking this will open the image directly in a new tab.
> *   **Solution**: This issue is not present in the **Seanime Desktop App**, where images render correctly.

> **Shift + Enter for New Lines**
>
> The input fields in Seanime's UI framework do not currently support the `Shift + Enter` keyboard shortcut for creating new lines. This behavior cannot be altered by the plugin. Please press `Enter` to submit your comment.

## 🙏 Acknowledgements

A huge thank you to [**5rahim**](https://github.com/5rahim) for creating Seanime and its powerful, flexible plugin system that makes projects like this possible.
