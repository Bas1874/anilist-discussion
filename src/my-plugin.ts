/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./core.d.ts" />

// Interfaces to define our data structures
interface User {
    name: string;
    avatar: { large: string; };
}
interface Thread {
    id: number;
    title:string;
    body: string;
    createdAt: number;
    replyCount: number;
    siteUrl: string;
    isEpisode: boolean;
    episodeNumber: number;
    user: User;
    replyUser: User | null;
    repliedAt: number;
    viewCount: number;
    categories?: { name: string }[];
}
interface ThreadComment {
    id: number;
    comment: string;
    createdAt: number;
    likeCount: number;
    isLiked: boolean;
    user: User;
    childComments?: ThreadComment[];
    isOptimistic?: boolean;
}
interface CommentSegment {
    type: 'text' | 'spoiler' | 'image' | 'link' | 'bold' | 'italic' | 'strike' | 'heading' | 'hr' | 'blockquote' | 'inline-code' | 'code-block' | 'br' | 'center' | 'youtube' | 'video' | 'user-link';
    content: string | CommentSegment[]; // Content can be a string or a list of nested segments
    // Additional metadata for specific types
    url?: string;
    level?: number;
    username?: string;
}


function init() {
    $ui.register((ctx) => {

        // --- Function to inject final custom scrollbar styles ---
        const stylesInjected = ctx.state(false);
        const injectScrollbarStyles = async () => {
            if (stylesInjected.get()) return;
            try {
                const css = `
                    ::-webkit-scrollbar {
                        width: 12px;
                    }
                    ::-webkit-scrollbar-track {
                        background: transparent;
                    }
                    ::-webkit-scrollbar-thumb {
                        background-color: rgba(255, 255, 255, 0.2);
                        border-radius: 10px;
                        border: 2px solid transparent;
                        background-clip: content-box;
                    }
                    ::-webkit-scrollbar-thumb:hover {
                        background-color: rgba(255, 255, 255, 0.4);
                    }
                `;
                const head = await ctx.dom.queryOne("head");
                if (head) {
                    const styleEl = await ctx.dom.createElement("style");
                    await styleEl.setText(css);
                    await head.append(styleEl);
                    stylesInjected.set(true);
                }
            } catch (e) {
                console.error("Failed to inject scrollbar styles:", e);
            }
        };
        // Inject styles when the UI context is registered
        injectScrollbarStyles();

        // --- HELPER FUNCTIONS ---

        function decodeHtmlEntities(text: string): string {
            if (!text) return "";
            return text.replace(/&#(\d+);/g, (match, dec) => {
                return String.fromCodePoint(parseInt(dec, 10));
            }).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
        }
        
        // --- SVG Icon Definitions ---
        const eyeIconSvg = `<svg aria-hidden="true" focusable="false" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path fill="currentColor" d="M572.52 241.4C518.29 135.59 410.93 64 288 64S57.68 135.64 3.48 241.41a32.35 32.35 0 0 0 0 29.19C57.71 376.41 165.07 448 288 448s230.32-71.64 284.52-177.41a32.35 32.35 0 0 0 0-29.19zM288 400a144 144 0 1 1 144-144 143.93 143.93 0 0 1-144 144zm0-240a95.31 95.31 0 0 0-25.31 3.79 47.85 47.85 0 0 1-66.9 66.9A95.78 95.78 0 1 0 288 160z"></path></svg>`;
        const commentsIconSvg = `<svg aria-hidden="true" focusable="false" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path fill="currentColor" d="M416 192c0-88.4-93.1-160-208-160S0 103.6 0 192c0 34.3 14.1 65.9 38 92-13.4 30.2-35.5 54.2-35.8 54.5-2.2 2.3-2.8 5.7-1.5 8.7S4.8 352 8 352c36.6 0 66.9-12.3 88.7-25 32.2 15.7 70.3 25 111.3 25 114.9 0 208-71.6 208-160zm122 220c23.9-26 38-57.7 38-92 0-66.9-53.5-124.2-129.3-148.1.9 6.6 1.3 13.3 1.3 20.1 0 105.9-107.7 192-240 192-10.8 0-21.3-.8-31.7-1.9C207.8 439.6 281.8 480 368 480c41 0 79.1-9.2 111.3-25 21.8 12.7 52.1 25 88.7 25 3.2 0 6.1-1.9 7.3-4.8 1.3-2.9.7-6.3-1.5-8.7-.3-.3-22.4-24.2-35.8-54.5z"></path></svg>`;

        function renderStatWithIcon(iconSvg: string, value: string | number) {
            const encodedSvg = `data:image/svg+xml;utf8,${encodeURIComponent(iconSvg)}`;
            return tray.flex([
                tray.div([], {
                    style: {
                        width: '18px',
                        height: '18px',
                        maskImage: `url(${encodedSvg})`,
                        maskSize: 'contain',
                        maskRepeat: 'no-repeat',
                        maskPosition: 'center',
                        backgroundColor: 'currentColor',
                    }
                }),
                tray.text({ text: `${value}` })
            ], { style: { alignItems: 'center', gap: 2 }});
        }

        // ===================================================================================
        // START OF NEW PARSING ENGINE
        // This version correctly handles all AniList formatting, including nesting.
        // ===================================================================================

        function parseComment(text: string): CommentSegment[] {
            const cleanedText = decodeHtmlEntities(text.replace(/<br>/g, '\n'));

            const blocks: (string | { type: 'code-block' | 'center' | 'spoiler'; content: string | CommentSegment[] })[] = [];
            let remainingText = cleanedText;

            const multilineRegex = /(^```([\s\S]*?)```)|(^~~~([\s\S]*?)~~~)|(^~!([\s\S]*?)!~)/gm;
            let lastIndex = 0;
            let match;
            while ((match = multilineRegex.exec(remainingText)) !== null) {
                if (match.index > lastIndex) {
                    blocks.push(remainingText.substring(lastIndex, match.index));
                }
                if (match[2] !== undefined) {
                    blocks.push({ type: 'code-block', content: match[2] });
                } else if (match[4] !== undefined) {
                    blocks.push({ type: 'center', content: match[4] });
                } else if (match[6] !== undefined) {
                    blocks.push({ type: 'spoiler', content: parseComment(match[6]) });
                }
                lastIndex = match.index + match[0].length;
            }
            if (lastIndex < remainingText.length) {
                blocks.push(remainingText.substring(lastIndex));
            }

            const inlineRules = [
                { type: 'user-link', regex: /^@([\w-]+)/, process: (m: RegExpMatchArray) => ({ content: m[0], username: m[1] }) },
                { type: 'image', regex: /^<a\s+href="([^"]+)"[^>]*>\s*<img\s+src="([^"]+)"[^>]*>\s*<\/a>/i, process: (m:RegExpMatchArray) => ({ url: m[1], content: m[2] }) },
                { type: 'image', regex: /^<img\s+src="([^"]+)"[^>]*>/i, process: (m: RegExpMatchArray) => ({ content: m[1] }) },
                { type: 'bold', regex: /^<b>([\s\S]*?)<\/b>/i, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1]) }) },
                { type: 'link', regex: /^<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i, process: (m: RegExpMatchArray) => ({ content: parseInline(m[2]), url: m[1] }) },
                { type: 'image', regex: /^img(\d*)\((.*?)\)/, process: (m: RegExpMatchArray) => ({ content: m[2] }) },
                { type: 'youtube', regex: /^youtube\(([^)]+)\)/, process: (m: RegExpMatchArray) => ({ type: 'link', url: `https://www.youtube.com/watch?v=${m[1]}`, content: `youtube.com/watch?v=${m[1]}` }) },
                { type: 'video', regex: /^video\(([^)]+)\)/, process: (m: RegExpMatchArray) => ({ type: 'link', url: m[1], content: m[1] }) },
                { type: 'link', regex: /^\[([^\]]+)\]\(([^)]+)\)/, process: (m: RegExpMatchArray) => ({ content: m[1], url: m[2] }) },
                { type: 'bold', regex: /^\*\*([\s\S]+?)\*\*|^\_\_([\s\S]+?)\_\_/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1] || m[2]) }) },
                { type: 'italic', regex: /^\*([\s\S]+?)\*|^\_([\s\S]+?)\_/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1] || m[2]) }) },
                { type: 'strike', regex: /^~~([\s\S]+?)~~/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1]) }) },
                { type: 'spoiler', regex: /^!~([\s\S]+?)!~/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1]) }) },
                { type: 'spoiler', regex: /^~!([\s\S]+?)!~/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1]) }) },
                { type: 'inline-code', regex: /^`([^`]+?)`/, process: (m: RegExpMatchArray) => ({ content: m[1] }) },
                { type: 'link', regex: /^(https?:\/\/[^\s<>"'{}|\\^`[\]]+)/, process: (m: RegExpMatchArray) => ({ content: m[1], url: m[1] }) },
            ];

            const lineStartRules = [
                { type: 'center', regex: /^#<center>(.*)/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1]) }) },
                { type: 'heading', regex: /^(#{1,5})\s+(.*)/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[2]), level: m[1].length }) },
                { type: 'blockquote', regex: /^>\s?(.*)/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1]) }) },
                { type: 'hr', regex: /^---\s*$/, process: () => ({ content: '' }) },
            ];

            const loneFormatterRules = [
                { type: 'bold', regex: /^\*\*([\s\S]+?)\*\*$/, process: (m: RegExpMatchArray) => parseInline(m[1]) },
                { type: 'bold', regex: /^\_\_([\s\S]+?)\_\_$/, process: (m: RegExpMatchArray) => parseInline(m[1]) },
                { type: 'italic', regex: /^\*([\s\S]+?)\*$/, process: (m: RegExpMatchArray) => parseInline(m[1]) },
                { type: 'italic', regex: /^\_([\s\S]+?)\_$/, process: (m: RegExpMatchArray) => parseInline(m[1]) },
                { type: 'strike', regex: /^~~([\s\S]+?)~~$/, process: (m: RegExpMatchArray) => parseInline(m[1]) },
            ];

            function parseInline(line: string): CommentSegment[] {
                if (!line) return [];
                const segments: CommentSegment[] = [];
                let text = line;

                while (text.length > 0) {
                    let matched = false;
                    for (const rule of inlineRules) {
                        const match = text.match(rule.regex);
                        if (match) {
                            matched = true;
                            const processed = rule.process(match);
                            segments.push({ type: rule.type as CommentSegment['type'], ...processed });
                            text = text.slice(match[0].length);
                            break;
                        }
                    }

                    if (!matched) {
                        const nextTokenIndex = text.search(/(@[\w-]+|\[|!~|~!|https?:\/\/|`|\*\*|\*|__|_|~~|img\(|youtube\(|video\(|<[a|img|b])/);
                        const plainTextEnd = nextTokenIndex === -1 ? text.length : nextTokenIndex;
                        const plainText = text.slice(0, plainTextEnd > 0 ? plainTextEnd : 1);

                        const lastSegment = segments[segments.length - 1];
                        if (lastSegment && lastSegment.type === 'text') {
                             (lastSegment.content as string) += plainText;
                        } else {
                            segments.push({ type: 'text', content: plainText });
                        }
                        text = text.slice(plainText.length);
                    }
                }
                return segments;
            }

            const resultSegments: CommentSegment[] = [];
            for (const block of blocks) {
                if (typeof block === 'object') {
                    if (block.type === 'center' && typeof block.content === 'string') {
                         resultSegments.push({ type: 'center', content: parseComment(block.content) });
                    } else if (block.type === 'spoiler') {
                         resultSegments.push({ type: 'spoiler', content: block.content as CommentSegment[] });
                    } else {
                        resultSegments.push(block as CommentSegment);
                    }
                } else {
                    const lines = block.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (!line && i < lines.length -1) {
                            resultSegments.push({ type: 'br', content: '' });
                            continue;
                        }

                        let isLoneFormatter = false;
                        for(const rule of loneFormatterRules){
                            const match = line.trim().match(rule.regex);
                            if(match){
                                resultSegments.push({ type: 'center', content: rule.process(match) });
                                isLoneFormatter = true;
                                break;
                            }
                        }

                        if (isLoneFormatter) {
                             if (i < lines.length - 1) resultSegments.push({ type: 'br', content: '' });
                             continue;
                        }

                        let matchedLineRule = false;
                        for(const rule of lineStartRules) {
                            const match = line.match(rule.regex);
                            if(match) {
                                matchedLineRule = true;
                                resultSegments.push({ type: rule.type as CommentSegment['type'], ...rule.process(match) });
                                break;
                            }
                        }

                        if (!matchedLineRule && line) {
                            resultSegments.push(...parseInline(line));
                        }
                        if (i < lines.length - 1) {
                            resultSegments.push({ type: 'br', content: '' });
                        }
                    }
                }
            }

            return resultSegments;
        }

        function renderSegment(segment: CommentSegment, key: string): any {
            const textStyle = { wordBreak: 'normal' as const, overflowWrap: 'break-word' as const, lineHeight: '1.6', display: 'inline' };

            const renderContent = (content: string | CommentSegment[]) => {
                if (typeof content === 'string') return [tray.text({ text: content, style: textStyle })];
                return content.map((subSegment, index) => renderSegment(subSegment, `${key}-${index}`));
            };

            const createWrapper = (children: any[], style: object, display: 'inline' | 'block' = 'inline', extraProps: object = {}) => {
                 return tray.div(children, { style: { ...style, display }, ...extraProps });
            };

            switch (segment.type) {
                case 'text': return tray.text({ text: segment.content as string, style: textStyle });
                case 'br': return tray.div([], { style: { height: '0.5em', width: '100%', display: 'block' } });
                case 'bold': return createWrapper(renderContent(segment.content as CommentSegment[]), { fontWeight: 'bold' });
                case 'italic': return createWrapper(renderContent(segment.content as CommentSegment[]), { fontStyle: 'italic' });
                case 'strike': return createWrapper(renderContent(segment.content as CommentSegment[]), { textDecoration: 'line-through' });
                case 'heading': return createWrapper(renderContent(segment.content as CommentSegment[]), { fontSize: '1.25em', fontWeight: 'semibold', marginTop: '0.5em', marginBottom: '0.5em'}, 'block');
                case 'hr': return tray.div([], { style: { borderTop: '1px solid #4A5568', margin: '8px 0', display: 'block' } });
                case 'blockquote': return createWrapper(renderContent(segment.content as CommentSegment[]), { borderLeft: '3px solid #4A5568', paddingLeft: '8px', color: '#A0AEC0', margin: '8px 0' }, 'block');
                case 'center': return createWrapper(renderContent(segment.content as CommentSegment[]), { textAlign: 'center', margin: '8px 0' }, 'block');
                case 'inline-code': return tray.text({ text: segment.content as string, style: { fontFamily: 'monospace', backgroundColor: '#2D3748', padding: '2px 4px', borderRadius: '4px', ...textStyle } });
                case 'code-block': return tray.div([tray.text({text: segment.content as string, style: { ...textStyle, display: 'block' }})], { style: { fontFamily: 'monospace', backgroundColor: '#1A202C', padding: '8px', borderRadius: '4px', whiteSpace: 'pre-wrap', width: '100%', display: 'block', margin: '8px 0' } });
                
                case 'spoiler':
                    const isRevealed = revealedSpoilers.get()[key];
                    if (isRevealed) {
                        return tray.stack([
                            tray.div(
                                renderContent(segment.content as CommentSegment[]),
                                {
                                    style: {
                                        background: '#2D3748',
                                        padding: '2px 4px',
                                        borderRadius: '4px',
                                        display: 'inline-block',
                                    }
                                }
                            ),
                            tray.button({
                                label: ' ',
                                onClick: ctx.eventHandler(key, () => {
                                    revealedSpoilers.set(s => ({ ...s, [key]: false }));
                                }),
                                style: {
                                    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                    background: 'transparent', border: 'none', color: 'transparent', cursor: 'pointer',
                                }
                            })
                        ], {
                            style: {
                                position: 'relative', display: 'inline-block', verticalAlign: 'baseline',
                            }
                        });
                    } else {
                        return tray.button({ 
                            label: "Spoiler", 
                            intent: "primary-subtle", 
                            size: "sm", 
                            onClick: ctx.eventHandler(key, () => {
                                revealedSpoilers.set(s => ({ ...s, [key]: true }));
                            }) 
                        });
                    }

                case 'image':
                    const imageUrl = segment.content as string;
                    const linkUrlForImage = segment.url || imageUrl;
                    return tray.stack([
                        tray.stack([
                            tray.div([], { 
                                style: { 
                                    width: '100%', 
                                    maxWidth: '300px', 
                                    aspectRatio: '16 / 9', 
                                    backgroundImage: `url(${imageUrl})`, 
                                    backgroundSize: 'contain', 
                                    backgroundPosition: 'center', 
                                    backgroundRepeat: 'no-repeat', 
                                    borderRadius: '4px', 
                                    backgroundColor: '#2D3748' 
                                } 
                            }),
                            tray.button({
                                label: ' ',
                                onClick: ctx.eventHandler(`view-image-${key}`, () => imageToView.set(imageUrl)),
                                style: {
                                    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                    background: 'transparent', border: 'none', cursor: 'pointer',
                                }
                            })
                        ], { style: { position: 'relative' } }),
                        tray.flex([
                            tray.text({ text: "Image may not load.", size: "sm", color: "gray" }),
                            ...(linkUrlForImage ? [tray.button({ label: "Open Link", intent: 'link', size: 'sm', onClick: ctx.eventHandler(`${key}-open`, () => linkConfirmation.set({ url: linkUrlForImage, message: "Are you sure you want to open this link?" })) })] : [])
                        ], { style: { gap: 2, alignItems: 'center', marginTop: '2px' } })
                    ], { style: { gap: 1, marginTop: '4px', display: 'inline-block' } });
                
                case 'link':
                     const linkContent = segment.content;
                     if(Array.isArray(linkContent) && linkContent.length > 0) {
                        return createWrapper(renderContent(linkContent), { color: '#66b2ff', textDecoration: 'underline', cursor: 'pointer' }, 'inline', { onClick: ctx.eventHandler(key, () => linkConfirmation.set({ url: segment.url!, message: "Are you sure you want to open this link?" }))});
                     }
                    const linkText = (segment.content as string).length > 50 ? (segment.content as string).substring(0, 47) + '...' : (segment.content as string);
                    return tray.button({ label: linkText, intent: 'link', size: 'sm', onClick: ctx.eventHandler(key, () => linkConfirmation.set({ url: segment.url!, message: "Are you sure you want to open this link?" })) });

                case 'user-link':
                    const userUrl = `https://anilist.co/user/${segment.username}`;
                    return tray.button({
                        label: segment.content as string,
                        intent: 'link',
                        size: 'sm',
                        onClick: ctx.eventHandler(`${key}-user`, () => linkConfirmation.set({ url: userUrl, message: "Are you sure you want to visit this user's profile?" }))
                    });

                default:
                    return tray.text({text: ''});
            }
        }

        // ===================================================================================
        // END OF NEW PARSING ENGINE
        // ===================================================================================

        function formatTimeAgo(timestamp: number): string {
            if (!timestamp) return "";
            const now = Date.now();
            const seconds = Math.floor((now - (timestamp * 1000)) / 1000);
            if (seconds < 30) return "just now";

            let interval = seconds / 31536000;
            if (interval > 1) return Math.floor(interval) + "y ago";
            interval = seconds / 2592000;
            if (interval > 1) return Math.floor(interval) + "mo ago";
            interval = seconds / 86400;
            if (interval > 1) return Math.floor(interval) + "d ago";
            interval = seconds / 3600;
            if (interval > 1) return Math.floor(interval) + "h ago";
            interval = seconds / 60;
            if (interval > 1) return Math.floor(interval) + "m ago";
            return Math.floor(seconds) + "s ago";
        }


        // --- STATE MANAGEMENT ---
        const currentUser = ctx.state<User | null>(null);
        const currentMediaId = ctx.state<number | null>(null);
        const currentMediaTitle = ctx.state<string | null>(null);
        const view = ctx.state<'list' | 'thread' | 'create' | 'edit-thread'>('list');
        const selectedThread = ctx.state<Thread | null>(null);
        const comments = ctx.state<ThreadComment[] | null>(null);
        const revealedSpoilers = ctx.state<{ [key: string]: boolean }>({});
        const isLoading = ctx.state(false);
        const error = ctx.state<string | null>(null);
        const replyingToCommentId = ctx.state<number | null>(null);
        const editingCommentId = ctx.state<number | null>(null);
        const isReplyingToThread = ctx.state(false);
        const isSubmitting = ctx.state(false);
        const replyInputRef = ctx.fieldRef<string>("");
        const editInputRef = ctx.fieldRef<string>("");
        const threadTitleInputRef = ctx.fieldRef<string>("");
        const threadBodyInputRef = ctx.fieldRef<string>("");
        const actionConfirmation = ctx.state<{ message: string; onConfirm: () => void; } | null>(null);
        const linkConfirmation = ctx.state<{ url: string; message: string; } | null>(null);
        const imageToView = ctx.state<string | null>(null);
        const commentSort = ctx.state<'ID' | 'ID_DESC'>('ID_DESC');
        const threadSort = ctx.state<string>('REPLIED_AT_DESC');
        const isSortMenuOpen = ctx.state(false);
        const commentsPage = ctx.state(1);
        const commentsHasNextPage = ctx.state(false);
        const fetchingMediaId = ctx.state<number | null>(null);
        const selectionState = ctx.state<{ start: number, end: number, text: string } | null>(null);
        const episodeDiscussions = ctx.state<Thread[]>([]);
        const generalDiscussions = ctx.state<Thread[]>([]);
        const displayedGeneralDiscussions = ctx.state<Thread[]>([]);
        const generalDiscussionsPage = ctx.state(1);
        const generalDiscussionsHasNextPage = ctx.state(false);
        const GENERAL_DISCUSSIONS_PER_PAGE = 20;


        // --- API SERVICE (ABSTRACTION) ---
        const anilistApi = {
            _fetch: async function(query: string, variables: any) {
                const token = $database.anilist.getToken();
                if (!token) throw new Error("Not authenticated with AniList.");
                const res = await ctx.fetch("https://graphql.anilist.co", {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ query, variables })
                });
                if (!res.ok) throw new Error(`AniList API Error: ${res.status}`);
                const json = await res.json();
                if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join(', '));
                return json.data;
            },
            fetchViewer: async function() {
                const query = `query { Viewer { name, avatar { large } } }`;
                const data = await this._fetch(query, {});
                return data.Viewer;
            },
            fetchThreadsPage: async function(mediaId: number, sort: string, page: number) {
                const query = `query ($mediaCategoryId: Int, $sort: [ThreadSort], $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage, currentPage }, threads(mediaCategoryId: $mediaCategoryId, sort: $sort) { id, title, body, createdAt, replyCount, siteUrl, repliedAt, viewCount, user { name, avatar { large } }, replyUser { name }, categories { name } } } }`;
                const data = await this._fetch(query, { mediaCategoryId: mediaId, sort: [sort], page: page });
                const processedThreads = (data.Page.threads || []).map((thread: any) => {
                    const isEpisode = thread.categories?.some((c: any) => c.name === "Release Discussion");
                    const match = thread.title.match(/(?:Episode|Ep\.?)\s*(\d+)/i);
                    return { ...thread, isEpisode: isEpisode, episodeNumber: match ? parseInt(match[1], 10) : 0 };
                });
                return { threads: processedThreads, pageInfo: data.Page.pageInfo };
            },
            fetchComments: async function(threadId: number, page: number) {
                const query = `query ($threadId: Int, $page: Int) { Page(page: $page, perPage: 25) { pageInfo { hasNextPage, currentPage }, threadComments(threadId: $threadId) { id, comment(asHtml: false), createdAt, likeCount, isLiked, user { name, avatar { large } }, childComments } } }`;
                const data = await this._fetch(query, { threadId, page });
                const parsed = (data.Page.threadComments || []).map((c: any) => ({ ...c, childComments: c.childComments || [] }));
                return { comments: parsed, pageInfo: data.Page.pageInfo };
            },
            toggleLike: function(commentId: number) {
                const mutation = `mutation ($id: Int, $type: LikeableType) { ToggleLike(id: $id, type: $type) { ... on ThreadComment { id } } }`;
                this._fetch(mutation, { id: commentId, type: "THREAD_COMMENT" }).catch(e => console.error("Like mutation failed:", e));
            },
            saveComment: async function(variables: { threadId: number, comment: string, parentCommentId?: number, id?: number }) {
                const mutation = `mutation ($id: Int, $threadId: Int, $parentCommentId: Int, $comment: String) { SaveThreadComment(id: $id, threadId: $threadId, parentCommentId: $parentCommentId, comment: $comment) { id, comment, createdAt, likeCount, isLiked, user { name, avatar { large } } } }`;
                const data = await this._fetch(mutation, variables);
                return data.SaveThreadComment;
            },
            deleteComment: async function(commentId: number) {
                const mutation = `mutation ($id: Int) { DeleteThreadComment(id: $id) { deleted } }`;
                const data = await this._fetch(mutation, { id: commentId });
                return data.DeleteThreadComment.deleted;
            },
            saveThread: async function(variables: { title: string, body: string, mediaCategories?: number[], categories?: number[], id?: number }) {
                const mutation = `mutation ($id: Int, $title: String, $body: String, $mediaCategories: [Int], $categories: [Int]) { SaveThread(id: $id, title: $title, body: $body, mediaCategories: $mediaCategories, categories: $categories) { id, title, body, createdAt, replyCount, siteUrl, user { name, avatar { large } } } }`;
                const data = await this._fetch(mutation, variables);
                return data.SaveThread;
            },
            deleteThread: async function(threadId: number) {
                const mutation = `mutation ($id: Int) { DeleteThread(id: $id) { deleted } }`;
                const data = await this._fetch(mutation, { id: threadId });
                return data.DeleteThread.deleted;
            }
        };

        // --- DATA FETCHING & MUTATIONS ---
        const fetchViewer = async () => {
            if (currentUser.get()) return;
            try {
                const viewer = await anilistApi.fetchViewer();
                if (viewer) currentUser.set(viewer);
            } catch (e: any) { console.error("Failed to fetch viewer info:", e.message); }
        };

        const fetchAndSeparateAllThreads = async (mediaId: number) => {
            if (isLoading.get()) return;
        
            isLoading.set(true);
            error.set(null);
            episodeDiscussions.set([]);
            generalDiscussions.set([]);
            displayedGeneralDiscussions.set([]);
            generalDiscussionsPage.set(1);
        
            try {
                const animeEntry = await ctx.anime.getAnimeEntry(mediaId);
                currentMediaTitle.set(animeEntry?.media?.title?.userPreferred || null);
        
                let allThreads: Thread[] = [];
                let page = 1;
                let hasNext = true;
        
                while (hasNext) {
                    const { threads: fetchedThreads, pageInfo } = await anilistApi.fetchThreadsPage(mediaId, threadSort.get(), page);
                    allThreads.push(...fetchedThreads);
                    hasNext = pageInfo.hasNextPage;
                    page++;
                }
        
                const epDiscussions = allThreads.filter(t => t.isEpisode);
                const genDiscussions = allThreads.filter(t => !t.isEpisode);
        
                episodeDiscussions.set(epDiscussions);
                generalDiscussions.set(genDiscussions);
        
                displayedGeneralDiscussions.set(genDiscussions.slice(0, GENERAL_DISCUSSIONS_PER_PAGE));
                generalDiscussionsHasNextPage.set(genDiscussions.length > GENERAL_DISCUSSIONS_PER_PAGE);
        
            } catch (e: any) {
                error.set(e.message);
            } finally {
                isLoading.set(false);
            }
        };


        const fetchComments = async (threadId: number, page: number = 1) => {
            isLoading.set(true); error.set(null);
            if (page === 1) comments.set(null);

            try {
                const { comments: newComments, pageInfo } = await anilistApi.fetchComments(threadId, page);

                let combinedComments = page > 1 ? [...(comments.get() || []), ...newComments] : newComments;

                const sortOrder = commentSort.get();
                if (sortOrder === 'ID_DESC') {
                    combinedComments.sort((a, b) => b.id - a.id);
                } else {
                    combinedComments.sort((a, b) => a.id - b.id);
                }

                comments.set(combinedComments);
                commentsPage.set(pageInfo.currentPage);
                commentsHasNextPage.set(pageInfo.hasNextPage);
            } catch (e: any) { error.set(e.message); }
            finally { isLoading.set(false); }
        };

        const handleToggleLike = (commentId: number) => {
            const updateCommentInTree = (commentList: ThreadComment[]): ThreadComment[] => {
                return commentList.map(comment => {
                    if (comment.id === commentId) {
                        return { ...comment, isLiked: !comment.isLiked, likeCount: comment.isLiked ? comment.likeCount - 1 : comment.likeCount + 1 };
                    }
                    if (comment.childComments) {
                        return { ...comment, childComments: updateCommentInTree(comment.childComments) };
                    }
                    return comment;
                });
            };
            comments.set(updateCommentInTree(comments.get() || []));
            anilistApi.toggleLike(commentId);
        };

        const handlePostReply = async (text: string, parentCommentId?: number) => {
            const threadId = selectedThread.get()?.id;
            if (!threadId || !text || isSubmitting.get()) return;

            isSubmitting.set(true); error.set(null);

            const me = currentUser.get();
            if (!me) { error.set("Cannot post reply, user data not loaded."); isSubmitting.set(false); return; }

            const temporaryId = Date.now();
            const newComment: ThreadComment = { id: temporaryId, comment: text, createdAt: Math.floor(Date.now() / 1000), likeCount: 0, isLiked: false, user: me, childComments: [], isOptimistic: true, };

            const addReplyToTree = (commentList: ThreadComment[], pId: number): ThreadComment[] => commentList.map(c => c.id === pId ? { ...c, childComments: [...(c.childComments || []), newComment] } : (c.childComments ? { ...c, childComments: addReplyToTree(c.childComments, pId) } : c));

            const currentComments = comments.get() || [];
            if (parentCommentId) comments.set(addReplyToTree(currentComments, parentCommentId));
            else comments.set([newComment, ...currentComments]);

            try {
                const realComment = await anilistApi.saveComment({ threadId, comment: text, parentCommentId });
                const replaceInTree = (commentList: ThreadComment[]): ThreadComment[] => commentList.map(c => c.id === temporaryId ? { ...realComment, childComments: [] } : (c.childComments ? { ...c, childComments: replaceInTree(c.childComments) } : c));
                comments.set(replaceInTree(comments.get() || []));
            } catch (e: any) {
                error.set("Failed to send reply.");
                const removeInTree = (commentList: ThreadComment[]): ThreadComment[] => commentList.filter(c => c.id !== temporaryId).map(c => c.childComments ? { ...c, childComments: removeInTree(c.childComments) } : c);
                comments.set(removeInTree(comments.get() || []));
            } finally {
                isSubmitting.set(false);
                replyingToCommentId.set(null);
                isReplyingToThread.set(false);
                replyInputRef.setValue("");
            }
        };

        const handleEditComment = async (commentId: number, newText: string) => {
            const threadId = selectedThread.get()?.id;
            if (!threadId || !newText || isSubmitting.get()) return;

            isSubmitting.set(true); error.set(null);

            let originalText = "";
            const findAndUpdateInTree = (list: ThreadComment[]): ThreadComment[] => list.map(c => c.id === commentId ? (originalText = c.comment, { ...c, comment: newText }) : (c.childComments ? { ...c, childComments: findAndUpdateInTree(c.childComments) } : c));
            comments.set(findAndUpdateInTree(comments.get() || []));
            editingCommentId.set(null);

            try {
                await anilistApi.saveComment({ id: commentId, threadId, comment: newText });
            } catch (e: any) {
                error.set("Failed to edit comment.");
                const rollbackInTree = (list: ThreadComment[]): ThreadComment[] => list.map(c => c.id === commentId ? { ...c, comment: originalText } : (c.childComments ? { ...c, childComments: rollbackInTree(c.childComments) } : c));
                comments.set(rollbackInTree(comments.get() || []));
            } finally {
                isSubmitting.set(false);
            }
        };

        const handleDeleteComment = async (commentId: number) => {
            if (isSubmitting.get()) return;
            isSubmitting.set(true); error.set(null);

            const removeCommentFromTree = (list: ThreadComment[]): ThreadComment[] => list.filter(c => c.id !== commentId).map(c => c.childComments ? { ...c, childComments: removeCommentFromTree(c.childComments) } : c);
            comments.set(removeCommentFromTree(comments.get() || []));

            try {
                const success = await anilistApi.deleteComment(commentId);
                if (!success) throw new Error("Deletion failed on server.");
            } catch (e: any) {
                error.set("Failed to delete comment. Please refresh.");
            } finally {
                isSubmitting.set(false);
            }
        };

        const handleSaveThread = async (id?: number) => {
            const title = threadTitleInputRef.current;
            const body = threadBodyInputRef.current;
            const mediaId = currentMediaId.get();
            const oldThread = selectedThread.get();

            if (!title || !body || !mediaId || isSubmitting.get()) {
                if (!title) ctx.toast.warning("Title is required.");
                if (!body) ctx.toast.warning("Body is required.");
                return;
            }

            isSubmitting.set(true);
            error.set(null);

            try {
                const savedThread = await anilistApi.saveThread({ id, title, body, mediaCategories: [mediaId], categories: [1] });
                ctx.toast.success(`Discussion ${id ? 'updated' : 'created'} successfully!`);
                
                const episodeMatch = title.match(/(?:Episode|Ep\.?)\s*(\d+)/i);
                const newThreadData: Thread = {
                    ...(oldThread || {}),
                    ...savedThread,
                    user: oldThread?.user || currentUser.get()!,
                    body,
                    title,
                    replyCount: oldThread?.replyCount || 0,
                    repliedAt: oldThread?.repliedAt || savedThread.createdAt,
                    replyUser: oldThread?.replyUser || null,
                    viewCount: oldThread?.viewCount || 0,
                    isEpisode: !!episodeMatch,
                    episodeNumber: episodeMatch ? parseInt(episodeMatch[1], 10) : 0,
                };

                selectedThread.set(newThreadData);
                view.set('thread');
                fetchAndSeparateAllThreads(mediaId);
            } catch (e: any) {
                error.set(`Failed to ${id ? 'update' : 'create'} discussion: ` + e.message);
                ctx.toast.alert(`Failed to ${id ? 'update' : 'create'} discussion.`);
            } finally {
                isSubmitting.set(false);
            }
        };

        const handleDeleteThread = async (threadId: number) => {
            if (isSubmitting.get()) return;
            isSubmitting.set(true);
            error.set(null);

            try {
                await anilistApi.deleteThread(threadId);
                ctx.toast.success("Discussion deleted.");
                view.set('list');
                fetchAndSeparateAllThreads(currentMediaId.get()!);
            } catch (e: any) {
                error.set("Failed to delete discussion: " + e.message);
                ctx.toast.alert("Failed to delete discussion.");
            } finally {
                isSubmitting.set(false);
            }
        };


        // --- TRAY SETUP & EVENT HANDLING ---
        const tray = ctx.newTray({
            tooltipText: "Discussions",
            iconUrl: "https://raw.githubusercontent.com/Bas1874/anilist-discussion/main/src/Icons/ad-Icon.png",
            withContent: true,
            width: '850px',
            height: '90vh'
        });

        tray.onOpen(() => {
            fetchViewer();
            const mediaId = currentMediaId.get();
            if (mediaId) {
                fetchAndSeparateAllThreads(mediaId);
            }
        });

        tray.onClose(() => {
            linkConfirmation.set(null);
            imageToView.set(null);
            actionConfirmation.set(null);
        });

        ctx.effect(() => { 
            const mediaId = currentMediaId.get();
            if (mediaId) {
                fetchAndSeparateAllThreads(mediaId);
            }
        }, [threadSort]);

        ctx.effect(() => { if (selectedThread.get()) fetchComments(selectedThread.get()!.id, 1); }, [selectedThread, commentSort]);

        ctx.registerEventHandler('inputSelectionChange', (e: { cursorStart: number, cursorEnd: number, selectedText: string }) => {
            selectionState.set({ start: e.cursorStart, end: e.cursorEnd, text: e.selectedText });
        });

        ctx.registerEventHandler("back-to-list", () => {
            view.set('list'); selectedThread.set(null); comments.set(null); revealedSpoilers.set({}); replyingToCommentId.set(null); editingCommentId.set(null); isSubmitting.set(false); commentsPage.set(1); commentsHasNextPage.set(false);
        });
        ctx.registerEventHandler("cancel-reply", () => { replyingToCommentId.set(null); isReplyingToThread.set(false); replyInputRef.setValue(""); });
        ctx.registerEventHandler("cancel-edit", () => { editingCommentId.set(null); editInputRef.setValue(""); });
        ctx.registerEventHandler("load-more-comments", () => { if (selectedThread.get()) fetchComments(selectedThread.get()!.id, commentsPage.get() + 1); });
        ctx.registerEventHandler("go-to-create-view", () => { threadTitleInputRef.setValue(""); threadBodyInputRef.setValue(""); view.set('create'); });
        ctx.registerEventHandler("submit-thread", () => handleSaveThread());
        ctx.registerEventHandler("submit-edit-thread", () => handleSaveThread(selectedThread.get()!.id));
        ctx.registerEventHandler('load-more-general-threads', () => {
            const currentPage = generalDiscussionsPage.get();
            const allGeneral = generalDiscussions.get();
            const nextStartIndex = currentPage * GENERAL_DISCUSSIONS_PER_PAGE;
            const nextEndIndex = nextStartIndex + GENERAL_DISCUSSIONS_PER_PAGE;
            
            const newThreads = allGeneral.slice(nextStartIndex, nextEndIndex);
            
            displayedGeneralDiscussions.set(d => [...d, ...newThreads]);
            generalDiscussionsPage.set(p => p + 1);
            generalDiscussionsHasNextPage.set(allGeneral.length > nextEndIndex);
        });
        
        function renderToolbar(fieldRef: any) {
            const applyFormatting = (prefix: string, suffix: string, isBlock: boolean = false) => {
                const selection = selectionState.get();
                let fullText = fieldRef.current || "";

                if (!selection) {
                    ctx.toast.warning("Please click inside the text box first.");
                    return;
                }

                if (isBlock && selection.start > 0 && fullText[selection.start - 1] !== '\n') {
                    prefix = '\n' + prefix;
                }

                const before = fullText.substring(0, selection.start);
                const selected = fullText.substring(selection.start, selection.end);
                const after = fullText.substring(selection.end);

                let newText;
                if (selected) { 
                    newText = before + prefix + selected + suffix + after;
                } else { 
                    newText = before + prefix + suffix + after;
                }
                fieldRef.setValue(newText);
            };

            return tray.flex([
                tray.button({ label: 'B', onClick: ctx.eventHandler('tb-b', () => applyFormatting('**', '**')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'I', onClick: ctx.eventHandler('tb-i', () => applyFormatting('*', '*')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'S', onClick: ctx.eventHandler('tb-s', () => applyFormatting('~~', '~~')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'H', onClick: ctx.eventHandler('tb-h', () => applyFormatting('# ', '', true)), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'Link', onClick: ctx.eventHandler('tb-link', () => applyFormatting('[', '](url)')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'Quote', onClick: ctx.eventHandler('tb-quote', () => applyFormatting('> ', '', true)), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'Code', onClick: ctx.eventHandler('tb-code', () => applyFormatting('`', '`')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'Spoiler', onClick: ctx.eventHandler('tb-spoiler', () => applyFormatting('~!', '!~')), size: 'sm', intent: 'gray-subtle' }),
            ], { style: { gap: 1, padding: '4px', backgroundColor: '#1A202C', borderRadius: '4px', marginBottom: '4px' } });
        }

        // --- SKELETON LOADERS ---
        function renderCommentSkeleton() {
            return tray.div([
                tray.flex([
                    tray.div([], { style: { width: '36px', height: '36px', borderRadius: '50%', backgroundColor: '#2D3748', flexShrink: 0 } }),
                    tray.stack([
                        tray.div([], { style: { height: '16px', width: '100px', backgroundColor: '#2D3748', borderRadius: '4px' } }),
                        tray.div([], { style: { height: '30px', width: '80%', backgroundColor: '#2D3748', borderRadius: '4px', marginTop: '4px' } })
                    ], { style: { flexGrow: 1, gap: 1 } })
                ], { style: { gap: 3, alignItems: 'start', opacity: 0.5 } })
            ], { style: { borderTop: '1px solid #2D3748', paddingTop: '12px', marginTop: '12px' } });
        }
        function renderThreadSkeleton() {
            return tray.div([
                tray.flex([
                    tray.div([], { style: { width: '40px', height: '40px', borderRadius: '50%', backgroundColor: '#2D3748', flexShrink: 0 } }),
                    tray.stack([
                        tray.div([], { style: { height: '18px', width: '70%', backgroundColor: '#2D3748', borderRadius: '4px' } }),
                        tray.flex([
                            tray.div([], { style: { height: '14px', width: '150px', backgroundColor: '#2D3748', borderRadius: '4px' } }),
                            tray.flex([
                                tray.div([], { style: { height: '14px', width: '50px', backgroundColor: '#2D3748', borderRadius: '4px' } }),
                                tray.div([], { style: { height: '14px', width: '50px', backgroundColor: '#2D3748', borderRadius: '4px' } }),
                                tray.div([], { style: { height: '14px', width: '120px', backgroundColor: '#2D3748', borderRadius: '4px' } })
                            ], { style: { gap: 2, alignItems: 'center' } })
                        ], { style: { justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' } })
                    ], { style: { flexGrow: 1, gap: 2 } })
                ], { style: { gap: 3, alignItems: 'center' } })
            ], { style: { padding: '10px 5px', borderBottom: '1px solid #2D3748', opacity: 0.5 }});
        }

        // --- UI RENDERING ---
        tray.render(() => {
            const centralMessage = (text: string) => tray.stack([tray.text(text)], { style: { height: '100%', alignItems: 'center', justifyContent: 'center' } });

            const mainContent = (() => {
                if (!currentMediaId.get()) return centralMessage("Navigate to an anime to see discussions.");

                if (isLoading.get() && episodeDiscussions.get().length === 0 && displayedGeneralDiscussions.get().length === 0 && !['create', 'edit-thread'].includes(view.get())) {
                     return tray.stack([
                        tray.text({ text: "Episode Discussions", size: "lg", align: "center", weight: "semibold" }),
                        tray.flex(Array(8).fill(0).map(() => tray.div([], { style: { width: '40px', height: '30px', backgroundColor: '#2D3748', borderRadius: '4px' } })), { style: { gap: 2, flexWrap: 'wrap', justifyContent: 'center', marginTop: '8px', opacity: 0.5 } }),
                        tray.div([], { style: { borderTop: '1px solid #2D3748', marginTop: '10px', marginBottom: '10px' } }),
                        tray.flex([
                            tray.text({ text: "General Discussions", size: "lg", weight: "semibold" }),
                            tray.flex([
                                tray.div([], { style: { height: '30px', width: '120px', backgroundColor: '#2D3748', borderRadius: '4px' } }),
                                tray.div([], { style: { height: '30px', width: '150px', backgroundColor: '#2D3748', borderRadius: '4px' } })
                            ], { style: { gap: 3 }})
                        ], { style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', opacity: 0.5 } }),
                        ...Array(5).fill(0).map(() => renderThreadSkeleton())
                    ], { style: { height: '100%', padding: '0 10px' } });
                }

                if (error.get()) return centralMessage(error.get()!);

                const me = currentUser.get();
                const renderComment = (comment: ThreadComment) => {
                    const isEditingThisComment = editingCommentId.get() === comment.id;

                    if (isEditingThisComment) {
                        return tray.div([
                            tray.stack([
                                renderToolbar(editInputRef),
                                tray.input({ placeholder: "Edit your comment...", fieldRef: editInputRef, textarea: true, onSelect: "inputSelectionChange" }),
                                tray.flex([
                                    tray.button({ label: isSubmitting.get() ? "Saving..." : "Save", intent: "primary", disabled: isSubmitting.get(), onClick: ctx.eventHandler(`save-edit-${comment.id}`, () => handleEditComment(comment.id, editInputRef.current!)) }),
                                    tray.button({ label: "Cancel", intent: "gray", onClick: "cancel-edit" })
                                ], { style: { gap: 2, justifyContent: 'flex-end' }})
                            ], { style: { marginTop: '8px' }})
                        ], { style: { borderTop: '1px solid #2D3748', paddingTop: '12px', marginTop: '12px' } });
                    }

                    const segments = parseComment(comment.comment);

                    const actionButtons = [
                        tray.button({ label: `♥ ${comment.likeCount}`, intent: comment.isLiked ? 'primary' : 'gray-subtle', size: 'sm', onClick: ctx.eventHandler(`like-comment-${comment.id}`, () => handleToggleLike(comment.id)) }),
                        tray.button({ label: `Reply`, intent: 'gray-subtle', size: 'sm', onClick: ctx.eventHandler(`reply-to-comment-${comment.id}`, () => { replyingToCommentId.set(comment.id); editingCommentId.set(null); isSubmitting.set(false); replyInputRef.setValue(""); })})
                    ];
                    if (me && comment.user.name === me.name) {
                        actionButtons.push(tray.button({ label: 'Edit', intent: 'gray-subtle', size: 'sm', onClick: ctx.eventHandler(`edit-comment-${comment.id}`, () => { editingCommentId.set(comment.id); editInputRef.setValue(comment.comment.replace(/<br>/g, '\n')); replyingToCommentId.set(null); isSubmitting.set(false); })}));
                        actionButtons.push(tray.button({ label: 'Delete', intent: 'alert-subtle', size: 'sm', onClick: ctx.eventHandler(`delete-comment-${comment.id}`, () => actionConfirmation.set({ message: "Are you sure you want to delete this comment?", onConfirm: () => handleDeleteComment(comment.id) }))}));
                    }

                    return tray.div([
                        tray.flex([
                            tray.div([], { style: { width: '36px', height: '36px', borderRadius: '50%', backgroundImage: `url(${comment.user.avatar.large})`, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 } }),
                            tray.stack([
                                tray.flex([
                                    tray.button({
                                        label: comment.user.name,
                                        intent: 'text',
                                        style: { color: 'white', fontWeight: 'semibold', padding: 0, height: 'auto', textDecoration: 'none' },
                                        hoverStyle: { textDecoration: 'underline' },
                                        onClick: ctx.eventHandler(`author-link-${comment.id}`, () => linkConfirmation.set({ url: `https://anilist.co/user/${comment.user.name}`, message: "Are you sure you want to visit this user's profile?" }))
                                    }),
                                    tray.text({ text: formatTimeAgo(comment.createdAt), size: "sm", color: "gray", style: { fontStyle: 'italic', marginLeft: '8px', whiteSpace: 'nowrap' } })
                                ], { style: { alignItems: 'baseline', alignSelf: 'flex-start' } }),
                                tray.div(segments.map((segment, index) => renderSegment(segment, `${comment.id}-${index}`)), { style: { display: 'block' } }),
                                tray.flex(actionButtons, { style: { gap: 2, marginTop: '4px' } })
                            ], { style: { flexGrow: 1, gap: 1, minWidth: 0 } })
                        ], { style: { gap: 3, alignItems: 'start' } }),

                        ...(replyingToCommentId.get() === comment.id ? [
                            tray.stack([
                                renderToolbar(replyInputRef),
                                tray.input({ placeholder: "Write a reply...", fieldRef: replyInputRef, textarea: true, onSelect: "inputSelectionChange" }),
                                tray.flex([
                                    tray.button({ label: isSubmitting.get() ? "Sending..." : "Send", intent: "primary", disabled: isSubmitting.get(), onClick: ctx.eventHandler(`send-reply-${comment.id}`, () => handlePostReply(replyInputRef.current!, comment.id)) }),
                                    tray.button({ label: "Cancel", intent: "gray", onClick: "cancel-reply" })
                                ], { style: { gap: 2, justifyContent: 'flex-end' }})
                            ], { style: { marginTop: '8px', marginLeft: '44px' } })
                        ] : []),

                        ...(comment.childComments && comment.childComments.length > 0 ?
                            [tray.div(comment.childComments.map(child => renderComment(child)), { style: { marginLeft: '12px', borderLeft: '2px solid #2D3748', paddingLeft: '16px' } })]
                            : [])
                    ], { style: { borderTop: '1px solid #2D3748', paddingTop: '12px', marginTop: '12px', opacity: comment.isOptimistic ? 0.6 : 1 } });
                };

                if (view.get() === 'create' || view.get() === 'edit-thread') {
                    const isEditing = view.get() === 'edit-thread';
                    return tray.stack([
                        tray.flex([
                            tray.button({ label: "< Back", intent: "gray-subtle", size: "sm", onClick: "back-to-list" }),
                        ], { style: { justifyContent: 'space-between', alignItems: 'center', paddingBottom: '8px', flexShrink: 0 } }),
                        tray.div([
                            tray.stack([
                                tray.text({ text: `${isEditing ? 'Edit' : 'Create'} a discussion for ${currentMediaTitle.get() || 'this anime'}`, weight: "semibold", size: "xl", align: "center" }),
                                tray.input({ label: "Title", fieldRef: threadTitleInputRef, placeholder: "Enter the discussion title" }),
                                tray.input({ label: "Body", fieldRef: threadBodyInputRef, placeholder: "Write your thoughts...", textarea: true, onSelect: "inputSelectionChange" }),
                                renderToolbar(threadBodyInputRef),
                                tray.flex([
                                    tray.button({ label: isSubmitting.get() ? "Submitting..." : (isEditing ? "Save Changes" : "Submit Discussion"), intent: "primary", disabled: isSubmitting.get(), onClick: isEditing ? "submit-edit-thread" : "submit-thread" }),
                                    tray.button({ label: "Cancel", intent: "gray", onClick: "back-to-list" }),
                                ], { style: { justifyContent: 'flex-end', gap: 2, marginTop: '12px' } })
                            ], { style: { gap: 4 } })
                        ], { style: { flexGrow: 1, overflowY: 'auto', padding: '1rem' }})
                    ], { style: { height: '100%', display: 'flex', flexDirection: 'column' } });
                }

                if (view.get() === 'thread' && selectedThread.get()) {
                    const thread = selectedThread.get()!;
                    const opSegments = parseComment(thread.body);
                    const currentComments = comments.get();
                    const isAuthor = me && thread.user.name === me.name;
                    
                    return tray.stack([
                        tray.flex([
                            tray.button({ label: "< Back", intent: "gray-subtle", size: "sm", onClick: "back-to-list" }),
                            tray.anchor({
                                text: "Open in Browser 🔗",
                                href: thread.siteUrl,
                                target: "_blank",
                                className: "bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-medium px-3 py-1.5 rounded-md transition-colors no-underline",
                            })
                        ], { style: { justifyContent: 'space-between', alignItems: 'center', paddingBottom: '8px', flexShrink: 0 } }),

                        tray.div([
                            tray.stack([
                                tray.text({ text: thread.title, weight: "semibold", size: "xl", align: "center" }),
                                tray.div([
                                    tray.flex([
                                        tray.div([], { style: { width: '36px', height: '36px', borderRadius: '50%', backgroundImage: `url(${thread.user.avatar.large})`, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 } }),
                                        tray.stack([
                                            tray.flex([
                                                tray.button({
                                                    label: thread.user.name,
                                                    intent: 'text',
                                                    style: { color: 'white', fontWeight: 'semibold', padding: 0, height: 'auto', textDecoration: 'none' },
                                                    hoverStyle: { textDecoration: 'underline' },
                                                    onClick: ctx.eventHandler(`op-author-link-${thread.id}`, () => linkConfirmation.set({ url: `https://anilist.co/user/${thread.user.name}`, message: "Are you sure you want to visit this user's profile?" }))
                                                }),
                                                tray.text({ text: formatTimeAgo(thread.createdAt), size: "sm", color: "gray", style: { fontStyle: 'italic', marginLeft: '8px', whiteSpace: 'nowrap' } })
                                            ], { style: { alignItems: 'baseline', alignSelf: 'flex-start' } }),
                                            tray.div(opSegments.map((segment, index) => renderSegment(segment, `op-${index}`)), { style: { display: 'block'} }),
                                            ...(isAuthor ? [
                                                tray.flex([
                                                    tray.button({ label: 'Edit', intent: 'gray-subtle', size: 'sm', onClick: ctx.eventHandler(`edit-thread-${thread.id}`, () => {
                                                        threadTitleInputRef.setValue(thread.title);
                                                        threadBodyInputRef.setValue(thread.body.replace(/<br>/g, '\n'));
                                                        view.set('edit-thread');
                                                    })}),
                                                    tray.button({ label: 'Delete', intent: 'alert-subtle', size: 'sm', onClick: ctx.eventHandler(`delete-thread-${thread.id}`, () => actionConfirmation.set({ message: "Are you sure you want to delete this discussion?", onConfirm: () => handleDeleteThread(thread.id) }))})
                                                ], { style: { gap: 2, marginTop: '8px' } })
                                            ] : [])
                                        ], { style: { flexGrow: 1, gap: 1, minWidth: 0 } })
                                    ], { style: { gap: 3, alignItems: 'start' } })
                                ], { style: { padding: '12px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', marginTop: '12px' } }),

                                tray.div([], { style: { borderTop: '1px solid #2D3748', marginTop: '20px', marginBottom: '10px' } }),
                                tray.flex([
                                    tray.button({ label: "Post a new comment", intent: "primary", onClick: ctx.eventHandler(`reply-to-thread`, () => { isReplyingToThread.set(!isReplyingToThread.get()); replyingToCommentId.set(null); editingCommentId.set(null); isSubmitting.set(false); }) }),
                                    tray.flex([
                                        tray.text({ text: "Sort:", size: "sm", color: "gray" }),
                                        tray.button({ label: "Newest", size: 'sm', intent: commentSort.get() === 'ID_DESC' ? 'primary-subtle' : 'gray-subtle', onClick: ctx.eventHandler('sort-new', () => commentSort.set('ID_DESC')) }),
                                        tray.button({ label: "Oldest", size: 'sm', intent: commentSort.get() === 'ID' ? 'primary-subtle' : 'gray-subtle', onClick: ctx.eventHandler('sort-old', () => commentSort.set('ID')) }),
                                    ], { style: { gap: 1, alignItems: 'center' } })
                                ], { style: { justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', marginBottom: '10px' } }),

                                ...(isReplyingToThread.get() ? [tray.stack([
                                    renderToolbar(replyInputRef),
                                    tray.input({ placeholder: "Write a new comment...", fieldRef: replyInputRef, textarea: true, onSelect: "inputSelectionChange" }),
                                    tray.flex([
                                        tray.button({ label: isSubmitting.get() ? "Sending..." : "Post Comment", intent: "primary", disabled: isSubmitting.get(), onClick: ctx.eventHandler(`send-reply-thread`, () => handlePostReply(replyInputRef.current!)) }),
                                        tray.button({ label: "Cancel", intent: "gray", onClick: "cancel-reply" })
                                    ], { style: { gap: 2, justifyContent: 'flex-end' }})
                                ], { style: { marginTop: '8px' }})] : []),

                                ...(isLoading.get() && !currentComments ? Array(3).fill(0).map(() => renderCommentSkeleton()) : []),
                                ...(currentComments && currentComments.length > 0 ? currentComments.map(comment => renderComment(comment)) : []),
                                ...(currentComments && currentComments.length === 0 && !isLoading.get() ? [tray.text({ text: "No comments yet. Be the first to post!", align: 'center', color: 'gray', style: { marginTop: '20px' } })] : []),
                                ...(currentComments && currentComments.length > 0 && !commentsHasNextPage.get() && !isLoading.get() ? [tray.flex([tray.text({ text: "End of Discussion", color: 'gray', size: 'sm' })], { style: { justifyContent: 'center', marginTop: '20px' } })] : []),
                                ...(commentsHasNextPage.get() ? [tray.button({ label: isLoading.get() ? "Loading..." : "Load More", intent: "primary-subtle", disabled: isLoading.get(), onClick: "load-more-comments", style: { marginTop: '12px' } })] : [])
                            ], {})
                        ], { style: { flexGrow: 1, overflowY: 'auto' } })
                    ], { style: { height: '100%', display: 'flex', flexDirection: 'column' } });
                }

                const epThreads = episodeDiscussions.get();
                const genThreads = displayedGeneralDiscussions.get();

                if (epThreads.length > 0 || genThreads.length > 0) {
                    const sortOptions = [
                        { label: "Last Reply", value: 'REPLIED_AT_DESC' },
                        { label: "Newest", value: 'CREATED_AT_DESC' },
                        { label: "Replies", value: 'REPLY_COUNT_DESC' },
                        { label: "Views", value: 'VIEW_COUNT_DESC' }
                    ];
                    const currentSortLabel = sortOptions.find(opt => opt.value === threadSort.get())?.label || "Sort by";

                    return tray.stack([
                        tray.div([
                            tray.stack([
                                tray.text({ text: "Episode Discussions", size: "lg", align: "center", weight: "semibold" }),
                                tray.flex(
                                    epThreads.sort((a, b) => a.episodeNumber - b.episodeNumber).map(thread =>
                                        tray.button({ label: `${thread.episodeNumber}`, intent: "primary-subtle", style: { minWidth: '40px', justifyContent: 'center' }, onClick: ctx.eventHandler(`select-thread-ep-${thread.id}`, () => { comments.set(null); isLoading.set(true); selectedThread.set(thread); view.set('thread'); }) })
                                    ),
                                    { style: { gap: 2, flexWrap: 'wrap', justifyContent: 'center', marginTop: '8px' } }
                                ),
                                tray.div([], { style: { borderTop: '1px solid #2D3748', marginTop: '10px', marginBottom: '10px' } }),
                                tray.flex([
                                    tray.text({ text: "General Discussions", size: "lg", weight: "semibold" }),
                                    tray.flex([
                                        tray.stack([
                                            tray.button({
                                                label: `Sort by: ${currentSortLabel}`,
                                                size: 'sm',
                                                intent: 'gray-subtle',
                                                onClick: ctx.eventHandler('toggle-sort-menu', () => isSortMenuOpen.set(!isSortMenuOpen.get()))
                                            }),
                                            ...(isSortMenuOpen.get() ? [
                                                tray.button({
                                                    label: ' ',
                                                    onClick: ctx.eventHandler('close-sort-backdrop', () => isSortMenuOpen.set(false)),
                                                    style: { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'transparent', border: 'none', zIndex: 40 }
                                                }),
                                                tray.stack(
                                                    sortOptions.map(option => tray.button({
                                                        label: option.label,
                                                        size: 'sm',
                                                        intent: threadSort.get() === option.value ? 'primary' : 'gray',
                                                        onClick: ctx.eventHandler(`sort-${option.value}`, () => {
                                                            threadSort.set(option.value);
                                                            isSortMenuOpen.set(false);
                                                        }),
                                                        style: { justifyContent: 'flex-start', width: '100%' }
                                                    })),
                                                    {
                                                        style: {
                                                            position: 'absolute',
                                                            top: '100%',
                                                            right: 0,
                                                            marginTop: '4px',
                                                            backgroundColor: '#2D3748',
                                                            border: '1px solid #4A5568',
                                                            borderRadius: '8px',
                                                            padding: '4px',
                                                            zIndex: 50,
                                                            width: '160px',
                                                            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
                                                        }
                                                    }
                                                )
                                            ] : [])
                                        ], { style: { position: 'relative' } }),
                                        tray.button({ label: "Create New Discussion", intent: "primary-subtle", size: "sm", onClick: "go-to-create-view" })
                                    ], { style: { alignItems: 'center', gap: 3 }})
                                ], { style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } }),
                                ...genThreads.map(thread =>
                                    tray.stack([
                                        tray.flex([
                                            tray.div([], { style: { width: '40px', height: '40px', borderRadius: '50%', backgroundImage: `url(${thread.user.avatar.large})`, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 } }),
                                            tray.stack([
                                                tray.text({ text: thread.title, weight: 'semibold' }),
                                                tray.flex([
                                                    tray.text({ text: `Created by ${thread.user.name}`, size: 'sm', color: 'gray' }),
                                                    tray.flex([
                                                        renderStatWithIcon(commentsIconSvg, thread.replyCount),
                                                        tray.text({ text: '·', size: 'sm', color: 'gray' }),
                                                        renderStatWithIcon(eyeIconSvg, thread.viewCount || 0),
                                                        tray.text({ text: '·', size: 'sm', color: 'gray' }),
                                                        tray.text({ text: `Last by ${thread.replyUser?.name || 'N/A'} ${formatTimeAgo(thread.repliedAt)}`, size: 'sm', color: 'gray' })
                                                    ], { style: { alignItems: 'center', gap: 2, flexWrap: 'nowrap' } })
                                                ], { style: { justifyContent: 'space-between', alignItems: 'center', color: '#A0AEC0', flexWrap: 'nowrap', whiteSpace: 'nowrap' } })
                                            ], { style: { flexGrow: 1, gap: 1 } })
                                        ], { style: { gap: 3, alignItems: 'center' } }),
                                        tray.button({
                                            label: ' ',
                                            style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'transparent', border: 'none', color: 'transparent', cursor: 'pointer' },
                                            onClick: ctx.eventHandler(`select-thread-${thread.id}`, () => { comments.set(null); isLoading.set(true); selectedThread.set(thread); view.set('thread'); })
                                        })
                                    ], {
                                        style: { position: 'relative', padding: '10px 5px', borderBottom: '1px solid #2D3748' },
                                        hoverStyle: { backgroundColor: 'rgba(255, 255, 255, 0.05)' }
                                    })
                                ),
                                ...(generalDiscussionsHasNextPage.get() ? [
                                    tray.button({
                                        label: isLoading.get() ? "Loading..." : "Load More",
                                        intent: "primary-subtle",
                                        disabled: isLoading.get(),
                                        onClick: 'load-more-general-threads',
                                        style: { marginTop: '12px', width: '100%' }
                                    })
                                ] : [])
                            ], {})
                        ], { style: { flexGrow: 1, overflowY: 'auto' } })
                    ], { style: { height: '100%', display: 'flex', flexDirection: 'column' } });
                }
                return centralMessage("No discussions found for this entry.");
            })();

            const actionConfirm = actionConfirmation.get();
            const linkConfirm = linkConfirmation.get();
            const viewedImageUrl = imageToView.get();
            return tray.div([
                mainContent,
                ...(linkConfirm ? [
                    tray.div([
                        tray.button({
                            label: " ",
                            onClick: ctx.eventHandler('close-modal-backdrop', () => linkConfirmation.set(null)),
                            style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'transparent', border: 'none', zIndex: 0, cursor: 'default' }
                        }),
                        tray.div([
                            tray.stack([
                                tray.text({ text: linkConfirm.message, weight: 'semibold', size: 'lg'}),
                                tray.text({ text: linkConfirm.url, size: "sm", color: "gray", style: { wordBreak: 'break-all' } }),
                                tray.flex([
                                     tray.div([
                                        tray.anchor({
                                            text: "Open",
                                            href: linkConfirm.url,
                                            target: "_blank",
                                            className: "bg-red-600 hover:bg-red-700 text-white font-medium text-sm rounded-md px-4 py-2 transition-colors no-underline inline-flex items-center justify-center",
                                        })
                                    ], { onClick: ctx.eventHandler('confirm-open-link', () => ctx.setTimeout(() => linkConfirmation.set(null), 150)) }),
                                    tray.button({
                                        label: "Cancel",
                                        intent: "gray",
                                        onClick: ctx.eventHandler('cancel-open-link', () => linkConfirmation.set(null)),
                                    })
                                ], { style: { gap: 2, justifyContent: 'center', marginTop: '12px' }})
                            ], { style: { gap: 2, alignItems: 'center' }})
                        ], {
                            style: { background: '#111827', border: '1px solid #374151', padding: '20px', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)', minWidth: '300px', maxWidth: '90%', position: 'relative', zIndex: 1 },
                            onClick: ctx.eventHandler('dialog-click-trap', () => {})
                        })
                    ], { style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0, 0, 0, 0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 } })
                ] : []),
                ...(actionConfirm ? [
                    tray.div([
                        tray.button({
                            label: " ",
                            onClick: ctx.eventHandler('close-modal-backdrop', () => actionConfirmation.set(null)),
                            style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'transparent', border: 'none', zIndex: 0, cursor: 'default' }
                        }),
                        tray.div([
                            tray.stack([
                                tray.text({ text: actionConfirm.message, weight: 'semibold', size: 'lg'}),
                                tray.flex([
                                     tray.button({
                                        label: "Confirm",
                                        intent: "alert",
                                        onClick: ctx.eventHandler('confirm-action', () => {
                                            actionConfirm.onConfirm();
                                            actionConfirmation.set(null);
                                        })
                                    }),
                                    tray.button({
                                        label: "Cancel",
                                        intent: "gray",
                                        onClick: ctx.eventHandler('cancel-action', () => { actionConfirmation.set(null); }),
                                    })
                                ], { style: { gap: 2, justifyContent: 'center', marginTop: '12px' }})
                            ], { style: { gap: 2, alignItems: 'center' }})
                        ], {
                            style: { background: '#111827', border: '1px solid #374151', padding: '20px', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)', minWidth: '300px', maxWidth: '90%', position: 'relative', zIndex: 1 },
                            onClick: ctx.eventHandler('dialog-click-trap', () => {})
                        })
                    ], { style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0, 0, 0, 0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 } })
                ] : []),
                ...(viewedImageUrl ? [
                    tray.div([
                        tray.button({
                            label: ' ',
                            onClick: ctx.eventHandler('close-image-view-backdrop', () => imageToView.set(null)),
                            style: {
                                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                background: 'transparent', border: 'none', zIndex: 0, cursor: 'default',
                            }
                        }),
                        tray.div([
                            tray.button({
                                label: ' ',
                                onClick: ctx.eventHandler('close-image-view-imageclick', () => imageToView.set(null)),
                                style: {
                                    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                    background: 'transparent', border: 'none', cursor: 'pointer', zIndex: 1,
                                }
                            })
                        ], {
                            style: {
                                position: 'relative',
                                width: '90vw',
                                height: '90vh',
                                backgroundImage: `url(${viewedImageUrl})`,
                                backgroundSize: 'contain',
                                backgroundPosition: 'center',
                                backgroundRepeat: 'no-repeat',
                                zIndex: 1,
                            },
                        }),
                        tray.button({
                            label: 'X',
                            onClick: ctx.eventHandler('close-image-view-button', () => imageToView.set(null)),
                            style: {
                                position: 'absolute', top: '10px', right: '10px', zIndex: 2, color: 'white',
                                background: 'rgba(0,0,0,0.5)', border: '1px solid white', borderRadius: '50%',
                                width: '30px', height: '30px', cursor: 'pointer',
                            }
                        })
                    ], {
                        style: {
                            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                            background: 'rgba(0, 0, 0, 0.8)', display: 'flex',
                            alignItems: 'center', justifyContent: 'center', zIndex: 110
                        }
                    })
                ] : [])
            ], { style: { position: 'relative', height: '100%' } });
        });

        // --- NAVIGATION ---
        ctx.screen.onNavigate((e) => {
            if (e.pathname === "/entry" && !!e.searchParams.id) {
                const id = parseInt(e.searchParams.id);
                if (currentMediaId.get() !== id) {
                    currentMediaId.set(id);
                    selectedThread.set(null);
                    view.set('list');
                    revealedSpoilers.set({});
                    replyingToCommentId.set(null);
                    editingCommentId.set(null);
                    isSubmitting.set(false);
                    commentsPage.set(1);
                    commentsHasNextPage.set(false);
                    fetchingMediaId.set(null);
                }
            } else {
                currentMediaId.set(null);
            }
        });
        ctx.screen.loadCurrent();
    });
}
