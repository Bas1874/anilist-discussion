/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./core.d.ts" />

const ENABLE_DEBUG_LOGGING = true;

// ===================================================================================
// INTERFACES
// ===================================================================================

interface User {
    name: string;
    avatar: { large: string; };
}
interface Thread {
    id: number;
    title: string;
    body: string;
    createdAt: number;
    replyCount: number;
    siteUrl: string;
    isEpisode: boolean;
    episodeNumber: number;
    user: User | null;
    repliedAt: number;
    viewCount: number;
    isLiked: boolean;
    likeCount: number;
    isSubscribed: boolean;
    replyUser: { name: string } | null;
}
interface ThreadComment {
    id: number;
    comment: string;
    createdAt: number;
    likeCount: number;
    isLiked: boolean;
    user: User | null;
    childComments?: ThreadComment[];
    isOptimistic?: boolean;
}
interface CommentSegment {
    type: 'text' | 'spoiler' | 'image' | 'link' | 'bold' | 'italic' | 'strike' | 'heading' | 'hr' | 'blockquote' | 'inline-code' | 'code-block' | 'br' | 'center' | 'youtube' | 'video' | 'user-link' | 'list-item';
    content: string | CommentSegment[];
    url?: string;
    level?: number;
    username?: string;
    width?: string;
}
interface ParsingRule {
    name: string;
    regex: RegExp;
    renderer: (match: RegExpMatchArray, parse: (text: string) => CommentSegment[]) => CommentSegment;
}
interface ConfirmationState {
    type: 'delete' | 'open-thread' | 'open-link' | 'open-user';
    message: string;
    data: string | number;
}
interface PreviewState {
    context: 'create-body' | 'thread-reply' | 'comment-reply' | 'comment-edit';
    id?: number;
}

// ===================================================================================
// MAIN PLUGIN
// ===================================================================================

function init() {
    $ui.register((ctx) => {
        const ANILIST_EPISODE_DISCUSSION_CATEGORY_ID = 5;
        const ANILIST_ANIME_DISCUSSION_CATEGORY_ID = 7;

        // --- 1. STATE MANAGEMENT ---
        const currentUser = ctx.state<User | null>(null);
        const currentMediaId = ctx.state<number | null>(null);
        
        // Data States
        const episodeDiscussions = ctx.state<Thread[]>([]);
        const generalDiscussions = ctx.state<Thread[]>([]);
        const selectedThread = ctx.state<Thread | null>(null);
        const comments = ctx.state<ThreadComment[] | null>(null);
        
        // UI States
        const view = ctx.state<'list' | 'thread' | 'create' | 'edit'>('list');
        const isLoading = ctx.state(false);
        const isSubmitting = ctx.state(false);
        const editingCommentId = ctx.state<number | null>(null);
        const replyingToCommentId = ctx.state<number | null>(null);
        const error = ctx.state<string | null>(null);
        const previewMode = ctx.state<PreviewState | null>(null);
        
        // Sorting & Filtering
        const threadSort = ctx.state<string>('REPLIED_AT_DESC'); 
        const commentSort = ctx.state<'ID' | 'ID_DESC'>('ID');
        const isSortMenuOpen = ctx.state(false);

        // Inputs
        const threadDraft = ctx.state<{ title: string; body: string }>({ title: "", body: "" });
        const activeReplyText = ctx.state<string>(""); 
        const activeEditText = ctx.state<string>(""); // New state for editing comments

        const confirmationState = ctx.state<ConfirmationState | null>(null);
        const hasAutoOpened = ctx.state(false);
        const wasChatOpen = ctx.state(false);
        
        // Pagination
        const commentsPage = ctx.state(1);
        const commentsHasNextPage = ctx.state(false);

        const sidebarRef = {
            contentElement: null as any,
            modalElement: null as any
        };

        // --- 2. HELPERS ---

        const INLINE_FORMAT_JS = `
            var wrapper = this.closest('.ad-input-wrapper');
            var el = wrapper ? wrapper.querySelector('textarea') : null;
            if(el) {
                var pre = this.getAttribute('data-pre');
                var suf = this.getAttribute('data-suf');
                var s = el.selectionStart, e = el.selectionEnd, v = el.value;
                el.value = v.substring(0, s) + pre + v.substring(s, e) + suf + v.substring(e);
                el.selectionStart = el.selectionEnd = s + pre.length + (e - s);
                el.focus();
                el.dispatchEvent(new Event('input', {bubbles:true}));
            }
        `.replace(/\n/g, ' ');

        const UPDATE_COUNTER_JS = `
            var min = parseInt(this.getAttribute('data-min-length') || '0');
            var len = this.value.length;
            var wrapper = this.closest('.ad-input-wrapper');
            var counter = wrapper ? wrapper.querySelector('.ad-char-counter') : null;
            if(counter) {
                if(len < min) {
                    counter.innerText = '(' + len + '/' + min + ')';
                    counter.style.display = 'inline';
                } else {
                    counter.innerText = '';
                    counter.style.display = 'none';
                }
            }
        `.replace(/\n/g, ' ');

        function formatTimeAgo(timestamp: number): string {
            if (!timestamp) return "";
            const now = Date.now();
            const seconds = Math.floor((now - (timestamp * 1000)) / 1000);
            if (seconds < 60) return "just now";
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return `${minutes}m ago`;
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return `${hours}h ago`;
            const days = Math.floor(hours / 24);
            if (days < 30) return `${days}d ago`;
            return `${Math.floor(days / 30)}mo ago`;
        }

        function decodeHtmlEntities(text: string): string {
            if (!text) return "";
            let str = text.replace(/<\/?br\s*\/?>/gi, '\n').replace(/\r\n/g, '\n');
            const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
            return str.replace(/&[a-z]+;|&#\d+;/gi, (match) => {
                const lower = match.toLowerCase();
                if (entities[lower]) return entities[lower];
                if (lower.startsWith('&#')) {
                    const code = parseInt(lower.slice(2, -1), 10);
                    return isNaN(code) ? match : String.fromCodePoint(code);
                }
                return match;
            });
        }

        function escapeHtmlAttribute(str: string): string {
            if (!str) return "";
            return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        const ICONS = {
            eye: `<svg aria-hidden="true" focusable="false" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512" style="width:12px;height:12px;vertical-align:middle;fill:currentColor;opacity:0.7"><path d="M572.52 241.4C518.29 135.59 410.93 64 288 64S57.68 135.64 3.48 241.41a32.35 32.35 0 0 0 0 29.19C57.71 376.41 165.07 448 288 448s230.32-71.64 284.52-177.41a32.35 32.35 0 0 0 0-29.19zM288 400a144 144 0 1 1 144-144 143.93 143.93 0 0 1-144 144zm0-240a95.31 95.31 0 0 0-25.31 3.79 47.85 47.85 0 0 1-66.9 66.9A95.78 95.78 0 1 0 288 160z"></path></svg>`,
            comment: `<svg aria-hidden="true" focusable="false" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512" style="width:12px;height:12px;vertical-align:middle;fill:currentColor;opacity:0.7"><path d="M416 192c0-88.4-93.1-160-208-160S0 103.6 0 192c0 34.3 14.1 65.9 38 92-13.4 30.2-35.5 54.2-35.8 54.5-2.2 2.3-2.8 5.7-1.5 8.7S4.8 352 8 352c36.6 0 66.9-12.3 88.7-25 32.2 15.7 70.3 25 111.3 25 114.9 0 208-71.6 208-160zm122 220c23.9-26 38-57.7 38-92 0-66.9-53.5-124.2-129.3-148.1.9 6.6 1.3 13.3 1.3 20.1 0 105.9-107.7 192-240 192-10.8 0-21.3-.8-31.7-1.9C207.8 439.6 281.8 480 368 480c41 0 79.1-9.2 111.3-25 21.8 12.7 52.1 25 88.7 25 3.2 0 6.1-1.9 7.3-4.8 1.3-2.9.7-6.3-1.5-8.7-.3-.3-22.4-24.2-35.8-54.5z"></path></svg>`,
            bell: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`,
            bellOff: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 1 18 8c0 7-3 9-3 9h2"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><line x1="1" y1="1" x2="23" y2="23"></line><path d="M6 8a6 6 0 0 0 0 12"></path></svg>`,
            refresh: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M3 21v-5h5"></path></svg>`,
            quote: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11h-4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c-1.5 0-2.3 2-2.3 4"></path><path d="M19 11h-4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c-1.5 0-2.3 2-2.3 4"></path></svg>`
        };

        // --- 3. MARKDOWN PARSER (Unchanged) ---
        const INLINE_RULES: ParsingRule[] = [
            { 
                name: 'anilist-sized-image', 
                regex: /^img([\d%]*)\(([^)]+)\)/i, 
                renderer: (m) => {
                    let w = m[1];
                    if (w && !w.includes('%')) w = w + 'px';
                    return { type: 'image', url: m[2], width: w, content: 'image' };
                } 
            },
            { name: 'anilist-video', regex: /^(?:webm|video)\(([^)]+)\)/i, renderer: (m) => ({ type: 'video', url: m[1], content: m[1] }) },
            { name: 'anilist-youtube', regex: /^youtube\(([^)]+)\)/i, renderer: (m) => { const val = m[1]; const idMatch = val.match(/v=([^&]+)/) || val.match(/youtu\.be\/([^?]+)/); return { type: 'youtube', url: `https://www.youtube.com/watch?v=${idMatch ? idMatch[1] : val}`, content: idMatch ? idMatch[1] : val }; } },
            { name: 'html-image', regex: /^<img\s+(?:[^>]*?\s+)?src=(["'])(.*?)\1[^>]*>/i, renderer: (m) => ({ type: 'image', url: m[2], content: 'image' }) },
            { name: 'markdown-image', regex: /^!\[([^\]]*)\]\(([^)]+(?:\([^)]+\)[^)]*)*)\)/, renderer: (m) => ({ type: 'image', content: m[1], url: m[2] }) },
            { name: 'html-link', regex: /^<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/i, renderer: (m, parse) => ({ type: 'link', url: m[2], content: parse(m[3]) }) },
            { name: 'markdown-link', regex: /^\[([^\]]+)\]\(([^)]+(?:\([^)]+\)[^)]*)*)\)/, renderer: (m, parse) => ({ type: 'link', content: parse(m[1]), url: m[2] }) },
            { name: 'user-link', regex: /^@([\w-]+)/, renderer: (m) => ({ type: 'user-link', content: m[0], username: m[1] }) },
            { name: 'anilist-spoiler', regex: /^(?:~!|!~)([\s\S]+?)(?:!~|~!)/, renderer: (m, parse) => ({ type: 'spoiler', content: parse(m[1]) }) },
            { name: 'inline-code', regex: /^`([^`]+)`/, renderer: (m) => ({ type: 'inline-code', content: m[1] }) },
            { name: 'bold', regex: /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/, renderer: (m, parse) => ({ type: 'bold', content: parse(m[2]) }) },
            { name: 'bold-html', regex: /^(?:<b>|<strong>)([\s\S]+?)(?:<\/b>|<\/strong>)/i, renderer: (m, parse) => ({ type: 'bold', content: parse(m[1]) }) },
            { name: 'italic', regex: /^(\*|_)(?=\S)([\s\S]*?\S)\1/, renderer: (m, parse) => ({ type: 'italic', content: parse(m[2]) }) },
            { name: 'italic-html', regex: /^(?:<i>|<em>)([\s\S]+?)(?:<\/i>|<\/em>)/i, renderer: (m, parse) => ({ type: 'italic', content: parse(m[1]) }) },
            { name: 'strike', regex: /^~~([\s\S]+?)~~/, renderer: (m, parse) => ({ type: 'strike', content: parse(m[1]) }) },
            { name: 'strike-html', regex: /^(?:<del>|<strike>)([\s\S]+?)(?:<\/del>|<\/strike>)/i, renderer: (m, parse) => ({ type: 'strike', content: parse(m[1]) }) },
            { name: 'auto-url', regex: /^(https?:\/\/[^\s<]+)/, renderer: (m) => ({ type: 'link', url: m[1], content: m[1] }) }
        ];

        function parseInline(text: string): CommentSegment[] {
            const segments: CommentSegment[] = [];
            let cursor = 0;
            while (cursor < text.length) {
                const remaining = text.slice(cursor);
                let bestMatch: { rule: ParsingRule, match: RegExpMatchArray } | null = null;
                for (const rule of INLINE_RULES) {
                    const match = remaining.match(rule.regex);
                    if (match && match.index === 0) { bestMatch = { rule, match }; break; }
                }
                if (bestMatch) {
                    segments.push(bestMatch.rule.renderer(bestMatch.match, parseInline));
                    cursor += bestMatch.match[0].length;
                } else {
                    const nextSpecial = remaining.search(/[*_~`<@\[!]|https?:|img|video|webm|youtube|`/i);
                    let textContent = "", advance = 0;
                    if (nextSpecial === -1) { textContent = remaining; advance = remaining.length; }
                    else if (nextSpecial === 0) { textContent = remaining[0]; advance = 1; }
                    else { textContent = remaining.slice(0, nextSpecial); advance = nextSpecial; }
                    
                    const lastSegment = segments[segments.length - 1];
                    if (lastSegment && lastSegment.type === 'text') lastSegment.content += textContent;
                    else segments.push({ type: 'text', content: textContent });
                    cursor += advance;
                }
            }
            return segments;
        }

        function parseParagraphsAndLists(text: string): CommentSegment[] {
            const res: CommentSegment[] = [];
            const lines = text.split('\n');
            let buffer = "";
            const flushBuffer = () => { if (buffer) { res.push(...parseInline(buffer)); buffer = ""; } };
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
                if (listMatch) {
                    flushBuffer();
                    const indent = Math.floor(listMatch[1].length / 2); 
                    res.push({ type: 'list-item', level: indent, content: parseInline(listMatch[3]) });
                } else {
                    buffer += line + (i < lines.length - 1 ? '\n' : '');
                }
            }
            flushBuffer();
            return res;
        }

        function parseComment(rawText: string): CommentSegment[] {
            const text = decodeHtmlEntities(rawText);
            const segments: CommentSegment[] = [];
            const blockSplitter = /(^```[\s\S]*?```)|(^~~~[\s\S]*?~~~|^<center>[\s\S]*?<\/center>)|(^>.*)|(^(?:#{1,6})\s+.*)|(^---$|^\*\*\*$)|((?:~!|!~)[\s\S]*?(?:!~|~!))|(<center>[\s\S]*?<\/center>)/gm;
            let lastIndex = 0, match;
            while ((match = blockSplitter.exec(text)) !== null) {
                if (match.index > lastIndex) {
                    const preBlockText = text.substring(lastIndex, match.index);
                    segments.push(...parseParagraphsAndLists(preBlockText));
                }
                const fullBlock = match[0];
                if (match[1]) segments.push({ type: 'code-block', content: match[1].replace(/^```|```$/g, '').trim() });
                else if (match[2]) segments.push({ type: 'center', content: parseInline(fullBlock.replace(/<center>|<\/center>|~~~/g, '').trim()) });
                else if (match[3]) segments.push({ type: 'blockquote', content: parseInline(fullBlock.replace(/^>\s?/gm, '').trim()) });
                else if (match[4]) segments.push({ type: 'heading', level: match[4].match(/^#+/)[0].length, content: parseInline(match[4].replace(/^#+\s*/, '')) });
                else if (match[5]) segments.push({ type: 'hr', content: '' });
                else if (match[6]) segments.push({ type: 'spoiler', content: parseComment(fullBlock.slice(2, -2)) });
                else if (match[7]) segments.push({ type: 'center', content: parseInline(fullBlock.replace(/^<center>|<\/center>$/gi, '').trim()) });
                lastIndex = match.index + fullBlock.length;
            }
            if (lastIndex < text.length) segments.push(...parseParagraphsAndLists(text.substring(lastIndex)));
            return segments;
        }

        // --- 4. HTML RENDERER ---

        function segmentsToHTML(segments: CommentSegment[]): string {
            return segments.map(seg => {
                if (typeof seg.content !== 'string' && Array.isArray(seg.content)) {
                    const innerHTML = segmentsToHTML(seg.content);
                    switch(seg.type) {
                        case 'bold': return `<b>${innerHTML}</b>`;
                        case 'italic': return `<i>${innerHTML}</i>`;
                        case 'strike': return `<s>${innerHTML}</s>`;
                        case 'spoiler': return `<span style="background:#333; color:transparent; cursor:pointer; padding:0 4px; border-radius:3px; transition: color 0.2s;" onclick="this.style.color='inherit'; this.style.background='rgba(50,50,50,0.5)'">${innerHTML}</span>`;
                        case 'blockquote': return `<blockquote style="border-left: 3px solid #555; padding-left: 10px; margin: 5px 0; opacity: 0.8; font-style: italic;">${innerHTML}</blockquote>`;
                        case 'center': return `<div style="text-align:center;">${innerHTML}</div>`;
                        case 'list-item': 
                            const marginLeft = (seg.level || 0) * 20;
                            return `<div style="margin-left: ${marginLeft}px; margin-bottom: 4px; display: flex;"><span style="margin-right: 8px; color: gray;">•</span><div>${innerHTML}</div></div>`;
                        case 'link': return `<a href="#" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-external-link', '${seg.url}'); return false;" style="color: #63b3ed; text-decoration: none;">${innerHTML}</a>`;
                        default: return innerHTML;
                    }
                }
                const content = seg.content as string;
                switch (seg.type) {
                    case 'text': return content; 
                    case 'link': return `<a href="#" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-external-link', '${seg.url}'); return false;" style="color: #63b3ed; text-decoration: none;">${content}</a>`;
                    case 'user-link': return `<a href="#" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-user-url', 'https://anilist.co/user/${seg.username}'); return false;" style="color: #a78bfa; text-decoration: none; font-weight: 500;">${content}</a>`;
                    case 'image': return `<img src="${seg.url || content}" style="max-width: 100%; border-radius: 4px; margin: 5px 0; display: block; ${seg.width ? `width: ${seg.width};` : ''}" />`;
                    case 'youtube': return `<div style="margin: 5px 0;"><a href="#" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-external-link', '${seg.url}'); return false;" style="display:block; padding: 10px; background: #222; color: white; border-radius: 5px; text-decoration: none; border:1px solid #333;">▶ Open YouTube Video</a></div>`;
                    case 'video': return `<div style="margin: 5px 0;"><a href="#" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-external-link', '${seg.url}'); return false;" style="display:inline-block; padding: 6px 12px; background: #2D3748; color: white; border-radius: 4px; text-decoration: none; font-size: 0.9em;">▶ Watch Video</a></div>`;
                    case 'code-block': return `<pre style="background: #111; padding: 10px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 0.85em;"><code>${content}</code></pre>`;
                    case 'inline-code': return `<code style="background: #1A202C; padding: 2px 4px; border-radius: 3px; font-family: monospace; font-size: 0.9em;">${content}</code>`;
                    case 'br': return `<br/>`;
                    case 'hr': return `<hr style="border: 0; border-top: 1px solid #333; margin: 10px 0;"/>`;
                    default: return content;
                }
            }).join('');
        }

        // --- 5. API & DATA ---

        const anilistApi = {
            _fetch: async function(query: string, variables: any) {
                const token = $database.anilist.getToken();
                if (!token) throw new Error("Not authenticated");
                const res = await ctx.fetch("https://graphql.anilist.co", {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ query, variables })
                });
                const json = await res.json();
                if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join(', '));
                if (!json.data) throw new Error("No data returned from AniList");
                return json.data;
            },
            fetchViewer: async function() {
                const data = await this._fetch(`query { Viewer { name, avatar { large } } }`, {});
                return data.Viewer;
            },
            fetchThreads: async function(mediaId: number, sort: string) {
                const query = `query ($mediaId: Int, $sort: [ThreadSort]) { Page(page: 1, perPage: 50) { threads(mediaCategoryId: $mediaId, sort: $sort) { id, title, body, createdAt, replyCount, siteUrl, user { name, avatar { large } }, isLocked, isSticky, isLiked, likeCount, viewCount, repliedAt, replyUser { name }, isSubscribed } } }`;
                const data = await this._fetch(query, { mediaId, sort: [sort] });
                return (data.Page.threads || []).map((t: any) => {
                    const match = t.title.match(/(?:Episode|Ep\.?|S\d+E)\s*(\d+)/i);
                    return { ...t, isEpisode: true, episodeNumber: match ? parseInt(match[1], 10) : 0 };
                });
            },
            fetchThread: async function(id: number) {
                const query = `query ($id: Int) { Thread(id: $id) { id, isSubscribed, isLiked, likeCount, viewCount, replyCount, repliedAt, replyUser { name } } }`;
                const data = await this._fetch(query, { id });
                return data.Thread;
            },
            fetchComments: async function(threadId: number, page: number) {
                const query = `query ($threadId: Int, $page: Int) { 
                    Page(page: $page, perPage: 25) { 
                        pageInfo { hasNextPage, currentPage }, 
                        threadComments(threadId: $threadId) { 
                            id, comment(asHtml: false), createdAt, likeCount, isLiked, 
                            user { name, avatar { large } }, 
                            childComments
                        } 
                    } 
                }`;
                const data = await this._fetch(query, { threadId, page });
                const parsed = (data.Page.threadComments || []).map((c: any) => ({ ...c, childComments: c.childComments || [] }));
                return { comments: parsed, pageInfo: data.Page.pageInfo };
            },
            saveComment: async function(threadId: number, comment: string, id?: number, parentCommentId?: number) {
                const query = `mutation ($id: Int, $threadId: Int, $parentCommentId: Int, $comment: String) { SaveThreadComment(id: $id, threadId: $threadId, parentCommentId: $parentCommentId, comment: $comment) { id, comment, createdAt, likeCount, isLiked, user { name, avatar { large } } } }`;
                const data = await this._fetch(query, { id, threadId, comment, parentCommentId });
                return data.SaveThreadComment;
            },
            saveThread: async function(variables: { title: string, body: string, mediaCategories?: number[], categories?: number[], id?: number }) {
                const mutation = `mutation ($id: Int, $title: String, $body: String, $mediaCategories: [Int], $categories: [Int]) { 
                    SaveThread(id: $id, title: $title, body: $body, mediaCategories: $mediaCategories, categories: $categories) { 
                        id, title, body, createdAt, replyCount, siteUrl, 
                        user { name, avatar { large } }, 
                        isLiked, likeCount, viewCount, repliedAt, isSubscribed 
                    } 
                }`;
                const data = await this._fetch(mutation, variables);
                return data.SaveThread;
            },
            toggleLike: async function(id: number) {
                await this._fetch(`mutation ($id: Int) { ToggleLike(id: $id, type: THREAD_COMMENT) { ... on User { id } } }`, { id });
            },
            toggleThreadLike: async function(id: number) {
                await this._fetch(`mutation ($id: Int) { ToggleLike(id: $id, type: THREAD) { ... on User { id } } }`, { id });
            },
            toggleThreadSubscription: async function(threadId: number, subscribe: boolean) {
                const mutation = `mutation ($threadId: Int, $subscribe: Boolean) { ToggleThreadSubscription(threadId: $threadId, subscribe: $subscribe) { id, isSubscribed } }`;
                const data = await this._fetch(mutation, { threadId, subscribe });
                return data.ToggleThreadSubscription;
            },
            deleteComment: async function(id: number) {
                await this._fetch(`mutation ($id: Int) { DeleteThreadComment(id: $id) { deleted } }`, { id });
            },
            deleteThread: async function(threadId: number) {
                const mutation = `mutation ($id: Int) { DeleteThread(id: $id) { deleted } }`;
                const data = await this._fetch(mutation, { id: threadId });
                return data.DeleteThread.deleted;
            }
        };

        const loadDiscussions = async (mediaId: number) => {
            if (!mediaId) return;
            isLoading.set(true);
            try {
                if (!currentUser.get()) {
                    const u = await anilistApi.fetchViewer();
                    currentUser.set(u);
                }
                const threads = await anilistApi.fetchThreads(mediaId, threadSort.get());
                const eps = threads.filter((t: any) => t.isEpisode && t.episodeNumber > 0).sort((a: any, b: any) => a.episodeNumber - b.episodeNumber);
                const gens = threads.filter((t: any) => !t.isEpisode || t.episodeNumber === 0);
                
                episodeDiscussions.set(eps);
                generalDiscussions.set(gens);
            } catch (e) { console.error("[AnilistDiscussions] Load error:", e); }
            finally { isLoading.set(false); }
        };

        const openThread = async (threadId: number) => {
            let thread = [...episodeDiscussions.get(), ...generalDiscussions.get()].find(t => t.id === threadId);
            if (thread) {
                selectedThread.set(thread);
            } else {
                 selectedThread.set({ id: threadId, title: "Loading...", body: "", createdAt: 0, replyCount: 0, siteUrl: "", isEpisode: false, episodeNumber: 0, user: null, repliedAt: 0, viewCount: 0, isLiked: false, likeCount: 0, isSubscribed: false, replyUser: null });
            }

            view.set('thread');
            isLoading.set(true);
            comments.set(null);
            
            try {
                const freshThreadData = await anilistApi.fetchThread(threadId);
                if (selectedThread.get()?.id === threadId) {
                    const current = selectedThread.get()!;
                    selectedThread.set({ ...current, ...freshThreadData });
                }

                const c = await anilistApi.fetchComments(threadId, 1);
                comments.set(c.comments);
                commentsPage.set(c.pageInfo.currentPage);
                commentsHasNextPage.set(c.pageInfo.hasNextPage);
            } catch(e) { console.error("Failed comments/thread details", e); }
            finally { isLoading.set(false); }
        };

        // --- 6. SIDEBAR RENDERER ---

        const updateSidebarContent = () => {
            if (!sidebarRef.contentElement || !sidebarRef.modalElement) return;
            
            const activeView = view.get();
            const activeThread = selectedThread.get();
            const activeComments = comments.get();
            const loading = isLoading.get();
            const me = currentUser.get();
            const editId = editingCommentId.get();
            const replyId = replyingToCommentId.get(); 
            const confirm = confirmationState.get();
            const submitting = isSubmitting.get();
            const currentSort = threadSort.get();
            const currentCommentSort = commentSort.get();
            const sortMenuOpen = isSortMenuOpen.get();
            const draft = threadDraft.get();
            const replyText = activeReplyText.get();
            const editText = activeEditText.get();
            const preview = previewMode.get();

            let contentHtml = `
                <style>
                    .ad-comment-node { position: relative; margin-bottom: 12px; }
                    .ad-comment-main { display: flex; gap: 12px; position: relative; z-index: 2; }
                    .ad-avatar-container { flex-shrink: 0; width: 32px; }
                    .ad-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: #333; display: block; }
                    .ad-comment-body { flex: 1; min-width: 0; }
                    .ad-meta { font-size: 0.75rem; color: #71717a; margin-top: 2px; }
                    .ad-author { font-weight: 600; font-size: 0.9rem; color: #f4f4f5; text-decoration: none; margin-right: 8px; }
                    .ad-text { font-size: 0.95rem; color: #e4e4e7; line-height: 1.5; margin: 4px 0 8px 0; white-space: pre-wrap; word-break: break-word; user-select: text; -webkit-user-select: text; cursor: text; }
                    .ad-actions { display: flex; gap: 16px; font-size: 0.8rem; color: #a1a1aa; align-items: center; }
                    .ad-action-btn { cursor: pointer; transition: color 0.2s; user-select: none; }
                    .ad-action-btn:hover { color: #fff; }
                    .ad-replies { margin-left: 15px; padding-left: 29px; border-left: 2px solid #333; display: flex; flex-direction: column; }
                    .ad-replies > .ad-comment-node { margin-bottom: 0; padding-top: 12px; }
                    .ad-replies > .ad-comment-node::before { content: ''; position: absolute; top: 0; left: -31px; width: 20px; height: 28px; border-bottom: 2px solid #333; border-left: 2px solid #333; border-bottom-left-radius: 12px; z-index: 1; }
                    .ad-optimistic { opacity: 0.5; }
                    .ad-preview-box { background: #1f1f1f; padding: 12px; border-radius: 4px; border: 1px solid #333; color: #eee; min-height: 60px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; font-size: 0.95rem; }
                    @keyframes ad-shimmer { 0% { background-position: -1000px 0; } 100% { background-position: 1000px 0; } }
                    .ad-skeleton { background: #222; background-image: linear-gradient(to right, #222 0%, #333 20%, #222 40%, #222 100%); background-repeat: no-repeat; background-size: 2000px 100%; animation: ad-shimmer 2s infinite linear; border-radius: 4px; }
                </style>
            `;
            
            const getToolbarHtml = (targetId: string) => `
                <div style="margin-bottom: 8px; display: flex; gap: 4px; flex-wrap: wrap;">
                    <button type="button" onclick="${INLINE_FORMAT_JS}" data-pre="**" data-suf="**" style="background:#333; border:none; color:#ccc; border-radius:3px; cursor:pointer; padding:3px 8px; font-weight:bold; font-size:0.8rem;">B</button>
                    <button type="button" onclick="${INLINE_FORMAT_JS}" data-pre="_" data-suf="_" style="background:#333; border:none; color:#ccc; border-radius:3px; cursor:pointer; padding:3px 8px; font-style:italic; font-size:0.8rem;">I</button>
                    <button type="button" onclick="${INLINE_FORMAT_JS}" data-pre="~~" data-suf="~~" style="background:#333; border:none; color:#ccc; border-radius:3px; cursor:pointer; padding:3px 8px; text-decoration:line-through; font-size:0.8rem;">S</button>
                    <button type="button" onclick="${INLINE_FORMAT_JS}" data-pre="~!" data-suf="!~" style="background:#333; border:none; color:#ccc; border-radius:3px; cursor:pointer; padding:3px 8px; font-size:0.8rem;">Spoiler</button>
                    <button type="button" onclick="${INLINE_FORMAT_JS}" data-pre="&gt; " data-suf="" style="background:#333; border:none; color:#ccc; border-radius:3px; cursor:pointer; padding:3px 8px; font-size:0.8rem;">Quote</button>
                </div>`;

            // Helper to render input box or preview
            const renderInputArea = (context: 'thread-reply' | 'comment-reply' | 'create-body' | 'comment-edit', id: string | number, value: string, placeholder: string, minHeight: string = '60px', showCancel = true) => {
                const uniqueId = `ad-input-${context}-${id}`;
                const isPreviewing = preview?.context === context && preview?.id == id;
                
                let html = `<div class="ad-input-wrapper" style="margin-top: 10px; margin-bottom: 10px; background: #1a1a1a; padding: 10px; border-radius: 6px;">`;
                
                if (isPreviewing) {
                    html += `
                        <div class="ad-preview-box">${segmentsToHTML(parseComment(value))}</div>
                        <div style="text-align: right; margin-top: 8px; display:flex; justify-content:flex-end; gap:8px;">
                             <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'write')" style="background: #333; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Write</button>
                        </div>
                    `;
                } else {
                    html += getToolbarHtml(uniqueId);
                    html += `<textarea id="${uniqueId}" placeholder="${placeholder}" style="width: 100%; background: #222; border: 1px solid #333; color: white; padding: 8px; border-radius: 4px; min-height: ${minHeight}; box-sizing: border-box; resize: vertical; font-family: inherit;">${decodeHtmlEntities(value)}</textarea>`;
                    
                    html += `<div style="text-align: right; margin-top: 8px; display:flex; justify-content:flex-end; gap:8px;">`;
                    
                    // Preview Button
                    html += `<button onclick="const val = document.getElementById('${uniqueId}').value; const btn = document.querySelector('[data-player-comment-btn]'); btn.setAttribute('data-preview-payload', encodeURIComponent(JSON.stringify({context: '${context}', id: '${id}', text: val})));" style="background: #333; color: #ccc; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Preview</button>`;

                    // Cancel Button
                    if (showCancel) {
                        const cancelAction = context === 'create-body' ? 'cancel-create' : context === 'comment-edit' ? 'cancel-edit' : 'cancel-reply';
                        html += `<button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', '${cancelAction}')" style="background: #333; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Cancel</button>`;
                    }

                    // Submit Button
                    if (context === 'create-body') {
                        // Special handling for thread create in parent template
                    } else if (context === 'comment-edit') {
                        html += `<button onclick="const val = document.getElementById('${uniqueId}').value; const btn = document.querySelector('[data-player-comment-btn]'); btn.setAttribute('data-submit-edit', encodeURIComponent(val));" style="background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; opacity: ${submitting ? '0.5' : '1'};" ${submitting ? 'disabled' : ''}>Save</button>`;
                    } else {
                        // Reply
                        const parentId = context === 'thread-reply' ? 'null' : id;
                        html += `<button onclick="const val = document.getElementById('${uniqueId}').value; const btn = document.querySelector('[data-player-comment-btn]'); btn.setAttribute('data-submit-reply', encodeURIComponent(JSON.stringify({text: val, parentId: ${parentId}})));" style="background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: 600; opacity: ${submitting ? '0.5' : '1'}; transition: opacity 0.2s;" ${submitting ? 'disabled' : ''}>${submitting ? 'Posting...' : 'Post'}</button>`;
                    }
                    html += `</div>`;
                }
                html += `</div>`;
                return html;
            };

            if (loading) {
                if (activeView === 'thread') {
                    contentHtml += `
                        <div style="padding-top: 10px;">
                            <div style="display:flex; justify-content:space-between; margin-bottom:15px;">
                                <div class="ad-skeleton" style="width: 80px; height: 16px;"></div>
                                <div class="ad-skeleton" style="width: 100px; height: 28px;"></div>
                            </div>
                            <div class="ad-skeleton" style="width: 70%; height: 24px; margin-bottom: 8px;"></div>
                            <div class="ad-skeleton" style="width: 30%; height: 14px; margin-bottom: 20px;"></div>
                            <div class="ad-skeleton" style="width: 100%; height: 120px; margin-bottom: 20px; border-radius: 8px;"></div>
                            <div style="display:flex; flex-direction:column; gap:20px; margin-top:30px;">
                                ${Array(5).fill(0).map(() => `
                                    <div style="display:flex; gap:12px;">
                                        <div class="ad-skeleton" style="width:32px; height:32px; border-radius:50%; flex-shrink:0;"></div>
                                        <div style="flex:1;">
                                            <div class="ad-skeleton" style="width: 120px; height: 14px; margin-bottom: 6px;"></div>
                                            <div class="ad-skeleton" style="width: 90%; height: 40px;"></div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;
                } else {
                    contentHtml += `
                        <div style="display:flex; flex-direction:column; gap:12px; margin-top:10px;">
                             <div class="ad-skeleton" style="width: 100%; height: 45px; margin-bottom: 10px; border-radius: 8px;"></div>
                             <div class="ad-skeleton" style="width: 100px; height: 16px; margin-bottom: 5px;"></div>
                             ${Array(6).fill(0).map(() => `
                                <div style="padding: 12px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333;">
                                    <div class="ad-skeleton" style="width: 60%; height: 18px; margin-bottom: 10px;"></div>
                                    <div style="display:flex; justify-content:space-between;">
                                        <div class="ad-skeleton" style="width: 20%; height: 14px;"></div>
                                        <div class="ad-skeleton" style="width: 25%; height: 14px;"></div>
                                    </div>
                                </div>
                             `).join('')}
                        </div>
                    `;
                }
            } else if (activeView === 'create' || activeView === 'edit') {
                const isEditing = activeView === 'edit';
                const currentTitle = draft.title;
                const currentBody = draft.body;
                const titleLen = currentTitle.length;
                const bodyLen = currentBody.length;
                const isPreviewing = preview?.context === 'create-body';
                const bodyInputId = 'ad-new-thread-body';
                
                contentHtml += `
                    <div style="padding-bottom: 20px;">
                        <h4 style="margin:0 0 15px 0; color:white; font-size:1.1rem; border-bottom:1px solid #333; padding-bottom:10px;">${isEditing ? 'Edit Discussion' : 'Create New Discussion'}</h4>
                        
                        <div class="ad-input-wrapper" style="margin-bottom: 15px;">
                            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                                <label style="color:#aaa; font-size:0.85rem; display:block;">Title</label>
                                <span id="ad-counter-title" class="ad-char-counter" style="color:#ef4444; font-size:0.75rem; display:${titleLen < 5 ? 'inline' : 'none'};">(${titleLen}/5)</span>
                            </div>
                            <input id="ad-new-thread-title" 
                                placeholder="Discussion Title" 
                                value="${escapeHtmlAttribute(currentTitle)}"
                                data-min-length="5"
                                oninput="${UPDATE_COUNTER_JS}"
                                style="width: 100%; background: #222; border: 1px solid #333; color: white; padding: 10px; border-radius: 4px; font-family: inherit; font-weight:bold; box-sizing: border-box;">
                        </div>
                        
                        <div class="ad-input-wrapper">
                            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                                <label style="color:#aaa; font-size:0.85rem; display:block;">Body</label>
                                <span id="ad-counter-body" class="ad-char-counter" style="color:#ef4444; font-size:0.75rem; display:${bodyLen < 20 ? 'inline' : 'none'};">(${bodyLen}/20)</span>
                            </div>
                            ${isPreviewing ? `
                                <div class="ad-preview-box">${segmentsToHTML(parseComment(currentBody))}</div>
                                <div style="text-align: right; margin-top: 8px; display:flex; justify-content:flex-end; gap:8px;">
                                    <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'write')" style="background: #333; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Write</button>
                                </div>
                            ` : `
                                ${getToolbarHtml(bodyInputId)}
                                <textarea id="${bodyInputId}" 
                                    placeholder="Write your thoughts..." 
                                    data-min-length="20"
                                    oninput="${UPDATE_COUNTER_JS}"
                                    style="width: 100%; background: #222; border: 1px solid #333; color: white; padding: 10px; border-radius: 4px; min-height: 150px; font-family: inherit; resize: vertical; box-sizing: border-box;">${decodeHtmlEntities(currentBody)}</textarea>
                                
                                <div style="text-align: right; margin-top: 8px; display:flex; justify-content:flex-end; gap:8px;">
                                    <button onclick="const val = document.getElementById('${bodyInputId}').value; const btn = document.querySelector('[data-player-comment-btn]'); btn.setAttribute('data-preview-payload', encodeURIComponent(JSON.stringify({context: 'create-body', id: 0, text: val})));" style="background: #333; color: #ccc; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Preview</button>
                                </div>
                            `}
                        </div>
                        
                        ${!isPreviewing ? `
                        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top: 15px;">
                            <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'cancel-create')" style="background: #333; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Cancel</button>
                            <button onclick="const t = document.getElementById('ad-new-thread-title').value; const b = document.getElementById('ad-new-thread-body').value; const btn = document.querySelector('[data-player-comment-btn]'); btn.setAttribute('data-submit-thread', encodeURIComponent(JSON.stringify({title: t, body: b})));" style="background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: 600; opacity: ${submitting ? '0.5' : '1'};" ${submitting ? 'disabled' : ''}>${submitting ? 'Saving...' : (isEditing ? 'Save Changes' : 'Create Discussion')}</button>
                        </div>
                        ` : ''}
                    </div>
                `;
            } else if (activeView === 'thread' && activeThread) {
                // Thread Detail
                const authorName = activeThread.user?.name || "Unknown User";
                const isOwner = me && activeThread.user && activeThread.user.name === me.name;

                contentHtml += `
                    <div style="padding: 0 0 10px 0; border-bottom: 1px solid #333; margin-bottom: 15px; display: flex; flex-direction: column; gap: 5px;">
                        <div style="display:flex; justify-content: space-between; align-items: flex-start;">
                            <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'back')" style="background:none; border:none; color:#aaa; cursor:pointer; font-size:0.9rem; padding: 5px 0;">&larr; Back to list</button>
                            <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-open-url', '${activeThread.siteUrl}')" style="background: #2563eb; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">Open in AniList</button>
                        </div>
                        <h4 style="margin:0; font-weight:600; color:white; font-size: 1.1rem; user-select: text; cursor: text;">${activeThread.title}</h4>
                        <div style="font-size:0.8rem; color:#888;">by ${authorName}</div>
                    </div>
                    <div style="padding-bottom: 20px;">
                `;

                const opSegments = parseComment(activeThread.body);
                contentHtml += `<div style="font-size:0.9rem; color:#ddd; margin-bottom:10px; padding:12px; background:#1f1f1f; border-radius:8px; line-height: 1.5; white-space: pre-wrap; user-select: text; cursor: auto;">${segmentsToHTML(opSegments)}</div>`;
                
                contentHtml += `<div style="display:flex; justify-content: space-between; margin-bottom: 12px;">`;
                if (isOwner) {
                    contentHtml += `
                        <div style="display:flex; gap:10px;">
                            <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'edit-thread')" style="background: #333; color: #ccc; border: 1px solid #444; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">Edit</button>
                            <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-delete-thread', '${activeThread.id}')" style="background: #450a0a; color: #f87171; border: 1px solid #7f1d1d; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">Delete</button>
                        </div>
                    `;
                } else {
                    contentHtml += `<div></div>`;
                }
                contentHtml += `
                    <div style="display:flex; gap:10px;">
                         <button title="Refresh" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'refresh-thread')" style="background:transparent; border:none; color:#ccc; cursor:pointer;">${ICONS.refresh}</button>
                         <button title="${activeThread.isSubscribed ? 'Unsubscribe' : 'Subscribe'}" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'toggle-subscribe')" style="background:transparent; border:none; color:${activeThread.isSubscribed ? '#3b82f6' : '#ccc'}; cursor:pointer;">${activeThread.isSubscribed ? ICONS.bell : ICONS.bellOff}</button>
                    </div>
                </div>`;

                contentHtml += `
                    <div style="display: flex; gap: 15px; font-size: 0.8rem; color: #888; margin-bottom: 10px; justify-content: flex-end; padding-right: 5px;">
                        <span 
                            onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-like-thread-id', '${activeThread.id}')" 
                            style="cursor: pointer; color: ${activeThread.isLiked ? '#ef4444' : 'inherit'}; user-select: none; transition: color 0.2s;"
                        >❤ ${activeThread.likeCount}</span>
                    </div>
                `;

                contentHtml += `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin: 15px 0 5px 0;">
                        <div style="font-size:0.9rem; font-weight:600; color:#eee;">Comments</div>
                        <div style="display:flex; gap: 5px;">
                            <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-set-comment-sort', 'ID_DESC')" style="background:${currentCommentSort === 'ID_DESC' ? '#2563eb' : '#333'}; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:0.75rem; cursor:pointer;">Newest</button>
                            <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-set-comment-sort', 'ID')" style="background:${currentCommentSort === 'ID' ? '#2563eb' : '#333'}; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:0.75rem; cursor:pointer;">Oldest</button>
                        </div>
                    </div>
                `;

                // Main Reply Box
                const isReplyingToThread = replyId === null && replyText !== "";
                contentHtml += renderInputArea('thread-reply', activeThread.id, isReplyingToThread ? replyText : "", "Write a reply...", '60px', false);

                const renderCommentTree = (c: ThreadComment) => {
                    const isEditing = editId === c.id;
                    const isReplying = replyId === c.id;
                    const cUser = c.user?.name ? c.user : { name: "Unknown", avatar: { large: "https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png" } };
                    const isOwner = me && cUser.name === me.name;
                    const isOptimistic = c.isOptimistic === true;
                    
                    let commentHtml = `<div class="ad-comment-node ${isOptimistic ? 'ad-optimistic' : ''}">`;

                    if (isEditing) {
                        commentHtml += renderInputArea('comment-edit', c.id, editText, "Edit comment...", '80px', true);
                    } else {
                        const cSegments = parseComment(c.comment);
                        commentHtml += `
                            <div class="ad-comment-main">
                                <div class="ad-avatar-container">
                                    <a href="#" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-user-url', 'https://anilist.co/user/${cUser.name}'); return false;">
                                        <img class="ad-avatar" src="${cUser.avatar.large}" />
                                    </a>
                                </div>
                                <div class="ad-comment-body">
                                    <div>
                                        <a class="ad-author" href="#" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-user-url', 'https://anilist.co/user/${cUser.name}'); return false;">${cUser.name}</a>
                                        <span class="ad-meta">${isOptimistic ? 'Sending...' : formatTimeAgo(c.createdAt)}</span>
                                    </div>
                                    <div class="ad-text">${segmentsToHTML(cSegments)}</div>
                                    <div class="ad-actions">
                                        <span class="ad-action-btn"
                                            onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-like-id', '${c.id}')" 
                                            style="color: ${c.isLiked ? '#ef4444' : 'inherit'};"
                                        >❤ ${c.likeCount}</span>
                                        ${!isOptimistic ? `
                                        <span class="ad-action-btn" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-reply-id', '${c.id}')">Reply</span>
                                        <span class="ad-action-btn" title="Quote" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-quote-comment-id', '${c.id}')">${ICONS.quote}</span>
                                        ${isOwner ? `
                                            <span class="ad-action-btn" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-edit-id', '${c.id}')">Edit</span>
                                            <span class="ad-action-btn" onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-prompt-delete-id', '${c.id}')" style="color: #b91c1c;">Delete</span>
                                        ` : ''}
                                        ` : ''}
                                    </div>
                                </div>
                            </div>
                        `;
                    }
                    if (isReplying) {
                        commentHtml += renderInputArea('comment-reply', c.id, replyText, "Write a reply...", '60px', true);
                    }
                    if (c.childComments && c.childComments.length > 0) {
                        commentHtml += `<div class="ad-replies">`;
                        commentHtml += c.childComments.map(child => renderCommentTree(child)).join('');
                        commentHtml += `</div>`;
                    }
                    commentHtml += `</div>`;
                    return commentHtml;
                };

                let displayedComments = activeComments ? [...activeComments] : [];
                if (currentCommentSort === 'ID_DESC') {
                    displayedComments.sort((a, b) => b.id - a.id);
                } else {
                    displayedComments.sort((a, b) => a.id - b.id);
                }

                if (displayedComments && displayedComments.length > 0) {
                    contentHtml += displayedComments.map(c => renderCommentTree(c)).join('');
                } else {
                    contentHtml += `<div style="text-align:center; padding:20px; color:#555;">No comments yet.</div>`;
                }

                if (commentsHasNextPage.get()) {
                    contentHtml += `<div style="text-align:center; margin-top:20px;"><button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'load-more-comments')" style="background:#333; color:#ccc; border:none; padding:8px 16px; border-radius:4px; cursor:pointer;">Load More</button></div>`;
                }

                contentHtml += `</div>`;
            } else {
                // ... (Thread List Rendering) ...
                 // Thread List
                if (episodeDiscussions.get().length === 0 && generalDiscussions.get().length === 0) {
                    contentHtml += `
                        <div style="text-align:center; padding: 2rem; color:#888; font-size: 0.9rem;">
                            No episode discussions found.<br><br>
                            <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'create-thread')" style="background:#2563eb; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">+ Start a Discussion</button>
                        </div>`;
                } else {
                    const epThreads = episodeDiscussions.get();
                    const genThreads = generalDiscussions.get();

                    contentHtml += `<div style="display:flex; flex-direction:column; gap:20px;">`;

                    contentHtml += `
                        <div style="margin-bottom: 5px;">
                            <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-action', 'create-thread')" style="width:100%; background:#1a1a1a; border:1px dashed #444; color:#aaa; padding:12px; border-radius:8px; cursor:pointer; font-weight:600; transition:all 0.2s;" onmouseover="this.style.background='#222'; this.style.color='#fff'; this.style.borderColor='#666'" onmouseout="this.style.background='#1a1a1a'; this.style.color='#aaa'; this.style.borderColor='#444'">+ Create New Discussion</button>
                        </div>
                    `;

                    // 1. Episode Buttons Grid
                    if (epThreads.length > 0) {
                        contentHtml += `
                            <div>
                                <h4 style="margin:0 0 10px 0; color:#888; font-size:0.85rem; text-transform:uppercase; letter-spacing:0.05em;">Episodes</h4>
                                <div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;">
                                    ${epThreads.map(t => `
                                        <button 
                                            onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-thread-id', '${t.id}')"
                                            style="
                                                min-width: 45px; height: 40px; padding: 0 10px; 
                                                background: #1a1a1a; border: 1px solid #333; border-radius: 6px; 
                                                color: #eee; cursor: pointer; font-weight: 600; font-size: 0.9rem;
                                                transition: all 0.2s;
                                                display: flex; align-items: center; justify-content: center;
                                            "
                                            onmouseover="this.style.background='#333'; this.style.borderColor='#555'" 
                                            onmouseout="this.style.background='#1a1a1a'; this.style.borderColor='#333'"
                                            title="${t.title}"
                                        >
                                            ${t.episodeNumber}
                                        </button>
                                    `).join('')}
                                </div>
                            </div>
                        `;
                    }

                    // 2. General Threads List
                    if (genThreads.length > 0) {
                        const sortLabelMap: any = {
                            'REPLIED_AT_DESC': 'Last Reply',
                            'CREATED_AT_DESC': 'Newest',
                            'REPLY_COUNT_DESC': 'Most Replies',
                            'VIEW_COUNT_DESC': 'Most Views'
                        };
                        const currentLabel = sortLabelMap[currentSort] || 'Sort by';

                        contentHtml += `
                            <div style="position:relative;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                    <h4 style="margin:0; color:#888; font-size:0.85rem; text-transform:uppercase; letter-spacing:0.05em;">General</h4>
                                    <button 
                                        onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-toggle-sort', 'true')"
                                        style="background:transparent; border:1px solid #333; color:#aaa; padding:2px 8px; border-radius:4px; font-size:0.75rem; cursor:pointer;"
                                    >${currentLabel} ▼</button>
                                    
                                    ${sortMenuOpen ? `
                                        <div style="position:absolute; top:25px; right:0; background:#2D3748; border:1px solid #4A5568; border-radius:6px; z-index:50; width:140px; box-shadow:0 4px 6px rgba(0,0,0,0.3);">
                                            ${Object.entries(sortLabelMap).map(([val, label]) => `
                                                <button 
                                                    onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-set-sort', '${val}')"
                                                    style="display:block; width:100%; text-align:left; background:${currentSort === val ? '#4A5568' : 'transparent'}; border:none; color:white; padding:8px 12px; cursor:pointer; font-size:0.8rem;"
                                                    onmouseover="this.style.background='#4A5568'"
                                                    onmouseout="this.style.background='${currentSort === val ? '#4A5568' : 'transparent'}'"
                                                >${label}</button>
                                            `).join('')}
                                        </div>
                                        <div 
                                            onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-toggle-sort', 'true')"
                                            style="position:fixed; top:0; left:0; width:100%; height:100%; z-index:40; cursor:default;"
                                        ></div>
                                    ` : ''}
                                </div>

                                <div style="display:flex; flex-direction:column; gap:8px;">
                                    ${genThreads.map(t => `
                                        <div 
                                            onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-thread-id', '${t.id}')"
                                            style="padding: 12px; background: #1a1a1a; border-radius: 8px; cursor: pointer; border: 1px solid #333; transition: background 0.2s;"
                                            onmouseover="this.style.background='#222'; this.style.borderColor='#444'" 
                                            onmouseout="this.style.background='#1a1a1a'; this.style.borderColor='#333'"
                                        >
                                            <div style="font-weight:600; font-size:0.95rem; color:#eee; margin-bottom: 6px;">${t.title}</div>
                                            <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#888; align-items:center;">
                                                <div style="display:flex; gap:10px; align-items:center;">
                                                    <span style="display:flex; align-items:center; gap:4px;">${ICONS.comment} ${t.replyCount}</span>
                                                    <span style="display:flex; align-items:center; gap:4px;">${ICONS.eye} ${t.viewCount || 0}</span>
                                                </div>
                                                <div style="text-align:right;">
                                                    <div>by ${t.user?.name || 'Unknown'}</div>
                                                    ${t.replyUser ? `<div>Last: ${t.replyUser.name} ${formatTimeAgo(t.repliedAt)}</div>` : ''}
                                                </div>
                                            </div>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                        `;
                    }
                    contentHtml += `</div>`;
                }
            }
            
            sidebarRef.contentElement.setInnerHTML(contentHtml);

            // Modal Rendering
            let modalHtml = "";
            if (confirm) {
                sidebarRef.modalElement.setStyle("pointer-events", "auto");
                sidebarRef.modalElement.setStyle("background", "rgba(0,0,0,0.8)");
                
                let yesAction = "";
                if (confirm.type === 'open-link' || confirm.type === 'open-user') {
                    yesAction = `onclick="window.open('${confirm.data}', '_blank'); document.querySelector('[data-player-comment-btn]').setAttribute('data-cancel-action', 'true')"`;
                } else if (confirm.type === 'delete' || 'delete-thread') {
                    yesAction = `onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-confirm-action', 'true')"`;
                }
                modalHtml = `
                <div style="background: #1a1a1a; padding: 20px; border-radius: 8px; border: 1px solid #333; width: 80%; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">
                    <h3 style="margin: 0 0 10px 0; color: white; font-size: 1rem;">Confirmation</h3>
                    <p style="color: #ccc; margin-bottom: 20px; font-size: 0.9rem;">${confirm.message}</p>
                    <div style="display: flex; gap: 10px; justify-content: center;">
                        <button ${yesAction} style="background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold;">Yes</button>
                        <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-cancel-action', 'true')" style="background: #333; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">No</button>
                    </div>
                </div>`;
            } else {
                sidebarRef.modalElement.setStyle("pointer-events", "none");
                sidebarRef.modalElement.setStyle("background", "transparent");
            }
            sidebarRef.modalElement.setInnerHTML(modalHtml);
        };

        const handleDeleteThread = async (threadId: number) => {
            if (isSubmitting.get()) return;
            isSubmitting.set(true);
            error.set(null);

            try {
                await anilistApi.deleteThread(threadId);
                ctx.toast.success("Discussion deleted.");
                view.set('list');
                selectedThread.set(null);
                loadDiscussions(currentMediaId.get()!);
            } catch (e: any) {
                console.error(e);
                error.set("Failed to delete discussion: " + e.message);
                ctx.toast.error("Failed to delete discussion.");
            } finally {
                isSubmitting.set(false);
                confirmationState.set(null); // Clear confirmation
            }
        };

        // --- 7. DOM OBSERVERS & BRIDGE ---
        enum DOMSelector {
            VideoPlayer = '[data-video-core-element="true"]',
            VideoPlayerPiP = ".vc-drawer-draggable-area",
            VideoPlayerControlButtonGroup = '[data-vc-element="control-bar-main-section"]',
            CommentSidePanel = "[data-player-comment-panel]",
            CommentButton = "[data-player-comment-btn]",
            EpisodeInfo = '[data-vc-element="top-playback-info-episode"]'
        }

        const tryAutoLoadThread = async () => {
            if (selectedThread.get() || hasAutoOpened.get()) return;
            const discussions = episodeDiscussions.get();
            if (!discussions || discussions.length === 0) return;
            const epEl = await ctx.dom.queryOne(DOMSelector.EpisodeInfo);
            if (epEl) {
                const text = await epEl.getText();
                const match = text.match(/(?:Episode|Ep\.?)\s*(\d+)/i);
                if (match) {
                    const epNum = parseInt(match[1]);
                    const thread = discussions.find(t => t.episodeNumber === epNum);
                    if (thread) {
                        hasAutoOpened.set(true);
                        openThread(thread.id);
                    }
                }
            }
        };

        ctx.dom.observe(DOMSelector.EpisodeInfo, async () => { tryAutoLoadThread(); });
        
        ctx.dom.observe(DOMSelector.VideoPlayer, async ([e]) => {
            try {
                if (!e) return;
                if (await ctx.dom.queryOne(DOMSelector.CommentSidePanel)) return;
                const inner = await e.getParent();
                const vCont = await inner?.getParent();
                const wrapper = await vCont?.getParent();
                if (!wrapper || !vCont) return;
                wrapper.setStyle("display", "flex");
                wrapper.setStyle("flex-direction", "row");
                wrapper.setStyle("overflow", "hidden");
                wrapper.setStyle("background-color", "#000");
                vCont.setStyle("flex", "1");
                vCont.setStyle("min-width", "0");
                vCont.setStyle("width", "auto");
                vCont.setStyle("position", "relative");
                vCont.setStyle("transition", "all 0.3s ease");
                const comments = await ctx.dom.createElement("aside");
                const attr = DOMSelector.CommentSidePanel.replace(/[[\]]/g, "");
                const styles = {
                    width: "0", "min-width": "0", "max-width": "0",
                    height: "calc(100% - 96px)", margin: "48px 0", "border-radius": "16px",
                    transition: "width 0.3s ease, min-width 0.3s ease, margin 0.3s ease",
                    background: "#0F0F0F", border: "none", display: "flex", "flex-direction": "column",
                    "z-index": "50", "box-sizing": "border-box", "overflow": "hidden"
                };
                for (const [k, v] of Object.entries(styles)) comments.setStyle(k, v);
                const header = await ctx.dom.createElement("div");
                header.setStyle("padding", "1.2rem");
                header.setStyle("border-bottom", "1px solid #2a2a2a");
                header.setStyle("background", "#141414");
                header.setStyle("flex-shrink", "0");
                header.setInnerHTML(`
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <h3 style="margin:0; font-weight:700; font-size: 1.2rem; color:#fff;">Discussions</h3>
                        <button onclick="document.querySelector('[data-player-comment-btn]').setAttribute('data-state', 'closed')" style="background:rgba(255,255,255,0.1); border:none; color:#fff; cursor:pointer; font-size:1rem; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center;">✕</button>
                    </div>
                `);
                const body = await ctx.dom.createElement("div");
                body.setStyle("flex", "1");
                body.setStyle("position", "relative");
                body.setStyle("overflow", "hidden");
                const scrollContainer = await ctx.dom.createElement("div");
                scrollContainer.setStyle("height", "100%");
                scrollContainer.setStyle("width", "100%");
                scrollContainer.setStyle("overflow-y", "auto");
                scrollContainer.setStyle("padding", "1rem");
                scrollContainer.setStyle("box-sizing", "border-box");
                scrollContainer.setStyle("scrollbar-width", "thin");
                scrollContainer.setStyle("scrollbar-color", "#333 transparent");
                const contentDiv = await ctx.dom.createElement("div");
                sidebarRef.contentElement = contentDiv;
                scrollContainer.append(contentDiv);
                const modalDiv = await ctx.dom.createElement("div");
                modalDiv.setStyle("position", "absolute");
                modalDiv.setStyle("top", "0");
                modalDiv.setStyle("left", "0");
                modalDiv.setStyle("width", "100%");
                modalDiv.setStyle("height", "100%");
                modalDiv.setStyle("background", "transparent");
                modalDiv.setStyle("z-index", "100");
                modalDiv.setStyle("display", "flex");
                modalDiv.setStyle("align-items", "center");
                modalDiv.setStyle("justify-content", "center");
                modalDiv.setStyle("pointer-events", "none");
                sidebarRef.modalElement = modalDiv;
                body.append(scrollContainer);
                body.append(modalDiv);
                comments.setAttribute(attr, "true");
                comments.append(header);
                comments.append(body);
                wrapper.append(comments);
                updateSidebarContent();
            } catch (err) { console.error(err); }
        });

        ctx.dom.observe(DOMSelector.VideoPlayerControlButtonGroup, async ([e]) => {
            try {
                if (!e || await ctx.dom.queryOne(DOMSelector.CommentButton)) return;
                const attrs = await e.getAttributes();
                if (attrs?.style && attrs.style.includes("height: 28px")) return;
                const btn = await ctx.dom.createElement("button");
                btn.setAttribute("data-player-comment-btn", "true");
                btn.setAttribute("data-state", "closed");
                btn.setAttribute("title", "Discussions"); 
                btn.setAttribute("onclick", "const s=this.getAttribute('data-state'); this.setAttribute('data-state', s==='open'?'closed':'open')");
                
                // Styles
                btn.setStyle("cursor", "pointer");
                btn.setStyle("pointer-events", "auto");
                btn.setStyle("padding", "0 10px"); 
                btn.setStyle("height", "100%");
                btn.setStyle("background", "transparent");
                btn.setStyle("border", "none");
                btn.setStyle("color", "white");
                btn.setStyle("display", "flex");
                btn.setStyle("align-items", "center");
                btn.setStyle("justify-content", "center");
                btn.setStyle("opacity", "0.9");
                btn.setStyle("transition", "color 0.2s, opacity 0.2s");

                // SVG Icon (Speech Bubble)
                btn.setInnerHTML(`
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                `);
                
                e.append(btn);
            } catch (err) { console.error(err); }
        });

        // Bridge Logic
        ctx.dom.observe(DOMSelector.CommentButton, async ([btn]) => {
            try {
                if (!btn) return;
                const attrs = await btn.getAttributes();
                const panel = await ctx.dom.queryOne(DOMSelector.CommentSidePanel);

                if (panel) {
                    if (attrs["data-state"] === "open") {
                        panel.setStyle("width", "35vw");
                        panel.setStyle("min-width", "350px");
                        panel.setStyle("max-width", "800px");
                        panel.setStyle("margin", "48px 24px 48px 0");
                        panel.setStyle("border", "1px solid #2a2a2a");
                        btn.setStyle("color", "#a78bfa");
                        if (!wasChatOpen.get()) tryAutoLoadThread();
                        wasChatOpen.set(true);
                    } else {
                        panel.setStyle("width", "0");
                        panel.setStyle("min-width", "0");
                        panel.setStyle("max-width", "0");
                        panel.setStyle("margin", "48px 0");
                        panel.setStyle("border", "none");
                        btn.setStyle("color", "white");
                        wasChatOpen.set(false);
                    }
                }

                if (attrs["data-thread-id"]) {
                    const id = parseInt(attrs["data-thread-id"]);
                    btn.setAttribute("data-thread-id", "");
                    openThread(id);
                }
                if (attrs["data-action"] === "back") {
                    btn.setAttribute("data-action", "");
                    selectedThread.set(null);
                    comments.set(null);
                    view.set('list');
                }
                
                // Sorting & Filtering Handlers
                if (attrs["data-toggle-sort"]) {
                    btn.setAttribute("data-toggle-sort", "");
                    isSortMenuOpen.set(!isSortMenuOpen.get());
                }
                if (attrs["data-set-sort"]) {
                    const val = attrs["data-set-sort"];
                    btn.setAttribute("data-set-sort", "");
                    threadSort.set(val);
                    isSortMenuOpen.set(false);
                }
                if (attrs["data-set-comment-sort"]) {
                    const val = attrs["data-set-comment-sort"] as 'ID' | 'ID_DESC';
                    btn.setAttribute("data-set-comment-sort", "");
                    commentSort.set(val);
                }

                if (attrs["data-action"] === "create-thread") {
                    btn.setAttribute("data-action", "");
                    threadDraft.set({ title: "", body: "" });
                    previewMode.set(null);
                    view.set('create');
                }
                if (attrs["data-action"] === "cancel-create") {
                    btn.setAttribute("data-action", "");
                    view.set('list');
                }
                
                // FIX: Add handlers for cancel-edit and cancel-reply via data-action
                if (attrs["data-action"] === "cancel-edit") {
                    btn.setAttribute("data-action", "");
                    editingCommentId.set(null);
                    activeEditText.set("");
                    previewMode.set(null);
                }

                if (attrs["data-action"] === "cancel-reply") {
                    btn.setAttribute("data-action", "");
                    replyingToCommentId.set(null);
                    activeReplyText.set(""); 
                    previewMode.set(null);
                }

                
                // New Edit Handler with state hydration
                if (attrs["data-action"] === "edit-thread") {
                    btn.setAttribute("data-action", "");
                    const thread = selectedThread.get();
                    if (thread) {
                        // Populate draft state with existing content
                        threadDraft.set({
                            title: thread.title,
                            body: thread.body
                        });
                        previewMode.set(null);
                        view.set('edit');
                    }
                }

                if (attrs["data-submit-thread"]) {
                    const raw = decodeURIComponent(attrs["data-submit-thread"]);
                    btn.setAttribute("data-submit-thread", "");
                    const { title, body } = JSON.parse(raw);
                    
                    if (title && body && currentMediaId.get()) {
                        if (title.trim().length < 5) {
                            ctx.toast.error("Title must be at least 5 characters.");
                            return;
                        }
                        if (body.trim().length < 20) {
                            ctx.toast.error("Body must be at least 20 characters.");
                            return;
                        }

                        isSubmitting.set(true);
                        try {
                            const isEditing = view.get() === 'edit';
                            const threadId = isEditing ? selectedThread.get()?.id : undefined;

                            const newThread = await anilistApi.saveThread({
                                title: title.trim(), 
                                body: body.trim(), 
                                mediaCategories: [currentMediaId.get()!],
                                categories: [ANILIST_ANIME_DISCUSSION_CATEGORY_ID],
                                id: threadId
                            });
                            
                            // user fallback
                            const threadUser = newThread.user || currentUser.get() || { name: 'You', avatar: { large: 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png' } };

                            if (isEditing) {
                                // Update existing thread in state
                                const currentT = selectedThread.get();
                                const updatedT = { 
                                    ...currentT, 
                                    ...newThread, 
                                    user: currentT?.user || threadUser // Preserve existing user if API fails to return it
                                };
                                selectedThread.set(updatedT as Thread);
                                
                                // Update list
                                const list = generalDiscussions.get();
                                const idx = list.findIndex(t => t.id === newThread.id);
                                if (idx !== -1) {
                                    const newList = [...list];
                                    newList[idx] = { 
                                        ...newList[idx], 
                                        ...newThread, 
                                        user: newList[idx].user || threadUser // Preserve user here too
                                    };
                                    generalDiscussions.set(newList);
                                }
                                view.set('thread');
                                ctx.toast.success("Discussion updated!");
                            } else {
                                // Add new thread to the list
                                const current = generalDiscussions.get();
                                const threadObj: Thread = {
                                    ...newThread,
                                    isEpisode: false,
                                    episodeNumber: 0,
                                    isLiked: false,
                                    likeCount: 0,
                                    repliedAt: newThread.createdAt,
                                    viewCount: 0,
                                    replyUser: null,
                                    user: threadUser
                                };
                                generalDiscussions.set([threadObj, ...current]);
                                view.set('list'); 
                                
                                // Open the new thread immediately
                                openThread(threadObj.id);
                                ctx.toast.success("Discussion created!");
                            }
                        } catch(e: any) {
                            console.error(e);
                            ctx.toast.error(`Error: ${e.message}`);
                        } finally {
                            isSubmitting.set(false);
                        }
                    }
                }

                if (attrs["data-action"] === "toggle-subscribe") {
                    btn.setAttribute("data-action", "");
                    const thread = selectedThread.get();
                    if (thread) {
                         const newSubState = !thread.isSubscribed;
                         const updatedT = { ...thread, isSubscribed: newSubState };
                         selectedThread.set(updatedT);
                         anilistApi.toggleThreadSubscription(thread.id, newSubState);
                    }
                }
                
                if (attrs["data-action"] === "refresh-thread") {
                    btn.setAttribute("data-action", "");
                    const thread = selectedThread.get();
                    if (thread) {
                        isLoading.set(true);
                        try {
                            const c = await anilistApi.fetchComments(thread.id, 1);
                            comments.set(c.comments);
                            commentsPage.set(c.pageInfo.currentPage);
                            commentsHasNextPage.set(c.pageInfo.hasNextPage);
                        } finally {
                            isLoading.set(false);
                        }
                    }
                }
                
                if (attrs["data-action"] === "load-more-comments") {
                    btn.setAttribute("data-action", "");
                    const thread = selectedThread.get();
                    if (thread) {
                        const newPage = commentsPage.get() + 1;
                        const c = await anilistApi.fetchComments(thread.id, newPage);
                        const current = comments.get() || [];
                        comments.set([...current, ...c.comments]);
                        commentsPage.set(c.pageInfo.currentPage);
                        commentsHasNextPage.set(c.pageInfo.hasNextPage);
                    }
                }
                
                if (attrs["data-open-internal-thread"]) {
                    const id = parseInt(attrs["data-open-internal-thread"]);
                    btn.setAttribute("data-open-internal-thread", "");
                    openThread(id);
                }

                if (attrs["data-quote-comment-id"]) {
                    const cId = parseInt(attrs["data-quote-comment-id"]);
                    btn.setAttribute("data-quote-comment-id", "");
                    
                    const findComment = (list: ThreadComment[]): ThreadComment | null => {
                        for (const c of list) {
                            if (c.id === cId) return c;
                            if (c.childComments) {
                                const found = findComment(c.childComments);
                                if (found) return found;
                            }
                        }
                        return null;
                    };
                    
                    const comment = findComment(comments.get() || []);
                    if (comment) {
                        replyingToCommentId.set(cId);
                        previewMode.set(null);
                        const quotedText = `> ${comment.comment.split('\n').join('\n> ')}\n\n`;
                        activeReplyText.set(quotedText); 
                    }
                }

                if (attrs["data-reply-id"]) {
                    replyingToCommentId.set(parseInt(attrs["data-reply-id"]));
                    activeReplyText.set(""); 
                    previewMode.set(null);
                    btn.setAttribute("data-reply-id", "");
                }
                
                if (attrs["data-cancel-reply"]) {
                    replyingToCommentId.set(null);
                    activeReplyText.set("");
                    previewMode.set(null);
                    btn.setAttribute("data-cancel-reply", "");
                }

                // PREVIEW LOGIC
                if (attrs["data-preview-payload"]) {
                    const raw = decodeURIComponent(attrs["data-preview-payload"]);
                    btn.setAttribute("data-preview-payload", "");
                    const { context, id, text } = JSON.parse(raw);
                    
                    // Update state with text so it persists when switching back
                    if (context === 'create-body') {
                        threadDraft.set({ ...threadDraft.get(), body: text });
                    } else if (context === 'thread-reply' || context === 'comment-reply') {
                        activeReplyText.set(text);
                    } else if (context === 'comment-edit') {
                        activeEditText.set(text);
                    }
                    
                    previewMode.set({ context, id: parseInt(id) });
                }

                if (attrs["data-action"] === "write") {
                    btn.setAttribute("data-action", "");
                    previewMode.set(null);
                }

                if (attrs["data-prompt-delete-id"]) {
                    const id = parseInt(attrs["data-prompt-delete-id"]);
                    btn.setAttribute("data-prompt-delete-id", "");
                    confirmationState.set({ type: 'delete', message: "Delete this comment?", data: id });
                }
                
                if (attrs["data-prompt-delete-thread"]) {
                    const id = parseInt(attrs["data-prompt-delete-thread"]);
                    btn.setAttribute("data-prompt-delete-thread", "");
                    confirmationState.set({ type: 'delete-thread' as any, message: "Delete this discussion? This cannot be undone.", data: id });
                }

                if (attrs["data-prompt-open-url"]) {
                    const url = attrs["data-prompt-open-url"];
                    btn.setAttribute("data-prompt-open-url", "");
                    confirmationState.set({ type: 'open-link', message: "Open discussion in AniList?", data: url });
                }
                if (attrs["data-prompt-external-link"]) {
                    const url = attrs["data-prompt-external-link"];
                    btn.setAttribute("data-prompt-external-link", "");
                    confirmationState.set({ type: 'open-link', message: "Open link?", data: url });
                }
                if (attrs["data-prompt-user-url"]) {
                    const url = attrs["data-prompt-user-url"];
                    btn.setAttribute("data-prompt-user-url", "");
                    confirmationState.set({ type: 'open-user', message: "Open user profile?", data: url });
                }

                if (attrs["data-confirm-action"]) {
                    btn.setAttribute("data-confirm-action", "");
                    const state = confirmationState.get();
                    if (state) {
                        if (state.type === 'delete') {
                            const deleteId = state.data as number;
                            isSubmitting.set(true);
                            try {
                                await anilistApi.deleteComment(deleteId);
                                const currentComments = comments.get() || [];
                                const removeFromTree = (list: ThreadComment[]): ThreadComment[] => {
                                    return list.filter(c => c.id !== deleteId).map(c => ({
                                        ...c,
                                        childComments: c.childComments ? removeFromTree(c.childComments) : []
                                    }));
                                };
                                comments.set(removeFromTree(currentComments));
                            } finally {
                                isSubmitting.set(false);
                                confirmationState.set(null);
                            }
                        } else if (state.type === 'delete-thread' as any) {
                             const deleteId = state.data as number;
                             handleDeleteThread(deleteId);
                        }
                    } else {
                        confirmationState.set(null);
                    }
                }
                if (attrs["data-cancel-action"]) {
                    btn.setAttribute("data-cancel-action", "");
                    confirmationState.set(null);
                }
                if (attrs["data-like-thread-id"]) {
                    const tId = parseInt(attrs["data-like-thread-id"]);
                    btn.setAttribute("data-like-thread-id", "");
                    const thread = selectedThread.get();
                    if (thread && thread.id === tId) {
                        const newLikedState = !thread.isLiked;
                        const newCount = newLikedState ? thread.likeCount + 1 : thread.likeCount - 1;
                        selectedThread.set({ ...thread, isLiked: newLikedState, likeCount: newCount });
                        await anilistApi.toggleThreadLike(tId);
                    }
                }
                if (attrs["data-like-id"]) {
                    const id = parseInt(attrs["data-like-id"]);
                    btn.setAttribute("data-like-id", "");
                    const currentComments = comments.get();
                    if (currentComments) {
                        const toggleLikeInTree = (list: ThreadComment[]): ThreadComment[] => {
                            return list.map(c => {
                                if (c.id === id) return { ...c, isLiked: !c.isLiked, likeCount: c.isLiked ? c.likeCount - 1 : c.likeCount + 1 };
                                if (c.childComments) return { ...c, childComments: toggleLikeInTree(c.childComments) };
                                return c;
                            });
                        };
                        comments.set(toggleLikeInTree(currentComments));
                    }
                    await anilistApi.toggleLike(id);
                }
                
                if (attrs["data-edit-id"]) {
                    const editId = parseInt(attrs["data-edit-id"]);
                    
                    // Pre-populate activeEditText with existing comment
                    const findComment = (list: ThreadComment[]): ThreadComment | null => {
                        for (const c of list) {
                            if (c.id === editId) return c;
                            if (c.childComments) {
                                const found = findComment(c.childComments);
                                if (found) return found;
                            }
                        }
                        return null;
                    };
                    const comment = findComment(comments.get() || []);
                    if (comment) {
                        activeEditText.set(comment.comment);
                    } else {
                        activeEditText.set("");
                    }
                    
                    editingCommentId.set(editId);
                    previewMode.set(null);
                    btn.setAttribute("data-edit-id", "");
                }
                if (attrs["data-cancel-edit"]) {
                    editingCommentId.set(null);
                    activeEditText.set("");
                    previewMode.set(null);
                    btn.setAttribute("data-cancel-edit", "");
                }
                if (attrs["data-submit-reply"]) {
                    const rawData = decodeURIComponent(attrs["data-submit-reply"]);
                    const data = JSON.parse(rawData);
                    btn.setAttribute("data-submit-reply", "");
                    if (data.text && selectedThread.get()) {
                        isSubmitting.set(true);
                        try {
                            const newComment = await anilistApi.saveComment(selectedThread.get()!.id, data.text, undefined, data.parentId || undefined);
                            if (!newComment.childComments) newComment.childComments = [];
                            const currentComments = comments.get() || [];
                            if (data.parentId) {
                                const addToTree = (list: ThreadComment[]): ThreadComment[] => {
                                    return list.map(c => {
                                        if (c.id === data.parentId) {
                                            return { ...c, childComments: [...(c.childComments || []), newComment] };
                                        }
                                        if (c.childComments) {
                                            return { ...c, childComments: addToTree(c.childComments) };
                                        }
                                        return c;
                                    });
                                };
                                comments.set(addToTree(currentComments));
                            } else {
                                comments.set([...currentComments, newComment]);
                            }
                            replyingToCommentId.set(null);
                            activeReplyText.set("");
                            previewMode.set(null);
                        } finally {
                            isSubmitting.set(false);
                        }
                    }
                }
                if (attrs["data-submit-edit"]) {
                    const text = decodeURIComponent(attrs["data-submit-edit"]);
                    const cId = editingCommentId.get();
                    btn.setAttribute("data-submit-edit", "");
                    if (text && cId && selectedThread.get()) {
                        isSubmitting.set(true);
                        try {
                            const updatedComment = await anilistApi.saveComment(selectedThread.get()!.id, text, cId);
                            const currentComments = comments.get() || [];
                            const updateTree = (list: ThreadComment[]): ThreadComment[] => {
                                return list.map(c => {
                                    if (c.id === cId) {
                                        return { ...c, comment: updatedComment.comment };
                                    }
                                    if (c.childComments) {
                                        return { ...c, childComments: updateTree(c.childComments) };
                                    }
                                    return c;
                                });
                            };
                            comments.set(updateTree(currentComments));
                            editingCommentId.set(null);
                            activeEditText.set("");
                            previewMode.set(null);
                        } finally {
                            isSubmitting.set(false);
                        }
                    }
                }

            } catch (err) { console.error(err); }
        });

        // Cleanup
        ctx.dom.observe(DOMSelector.VideoPlayerPiP, async () => {
            const btn = await ctx.dom.queryOne(DOMSelector.CommentButton);
            if(btn) btn.remove();
            const panel = await ctx.dom.queryOne(DOMSelector.CommentSidePanel);
            if(panel) { panel.setStyle("width", "0"); panel.setStyle("min-width", "0"); panel.setStyle("border", "none"); }
        });

        // Auto-load trigger when data becomes available
        ctx.effect(() => {
            tryAutoLoadThread();
        }, [episodeDiscussions]);

        // Watch for Sorting changes to reload general discussions
        ctx.effect(() => {
            if (currentMediaId.get()) {
                loadDiscussions(currentMediaId.get()!);
            }
        }, [threadSort]);

        // Initial Logic
        ctx.effect(() => updateSidebarContent(), [selectedThread, comments, episodeDiscussions, generalDiscussions, isLoading, editingCommentId, replyingToCommentId, isSubmitting, confirmationState, view, threadSort, commentSort, isSortMenuOpen, threadDraft, activeReplyText, activeEditText, previewMode]);
        
        ctx.screen.onNavigate(async (e) => {
            if (e.pathname === "/entry" && !!e.searchParams.id) {
                const id = parseInt(e.searchParams.id);
                if (currentMediaId.get() !== id) {
                    currentMediaId.set(id);
                    hasAutoOpened.set(false);
                    wasChatOpen.set(false);
                    selectedThread.set(null);
                    comments.set(null);
                    view.set('list');
                    await loadDiscussions(id);
                }
            }
        });
        ctx.screen.loadCurrent();
    });
}
