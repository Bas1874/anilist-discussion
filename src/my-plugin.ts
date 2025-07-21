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
    type: 'text' | 'spoiler' | 'image' | 'link' | 'bold' | 'italic' | 'strike' | 'heading' | 'hr' | 'blockquote' | 'inline-code' | 'code-block' | 'br' | 'center' | 'youtube' | 'video';
    content: string | CommentSegment[]; // Content can be a string or a list of nested segments
    // Additional metadata for specific types
    url?: string;
    level?: number;
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

        // ===================================================================================
        // START OF NEW PARSING ENGINE
        // This version correctly handles all AniList formatting, including nesting.
        // ===================================================================================

        function parseComment(text: string): CommentSegment[] {
            const cleanedText = decodeHtmlEntities(text.replace(/<br>/g, '\n'));

            const blocks: (string | { type: 'code-block' | 'center' | 'spoiler'; content: string })[] = [];
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
                    blocks.push({ type: 'spoiler', content: match[6] });
                }
                lastIndex = match.index + match[0].length;
            }
            if (lastIndex < remainingText.length) {
                blocks.push(remainingText.substring(lastIndex));
            }

            const inlineRules = [
                // HTML rules first to override markdown
                { type: 'image', regex: /^<a\s+href="([^"]+)"[^>]*>\s*<img\s+src="([^"]+)"[^>]*>\s*<\/a>/i, process: (m:RegExpMatchArray) => ({ url: m[1], content: m[2] }) },
                { type: 'image', regex: /^<img\s+src="([^"]+)"[^>]*>/i, process: (m: RegExpMatchArray) => ({ content: m[1] }) },
                { type: 'bold', regex: /^<b>([\s\S]*?)<\/b>/i, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1]) }) },
                { type: 'link', regex: /^<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i, process: (m: RegExpMatchArray) => ({ content: parseInline(m[2]), url: m[1] }) },
                // Markdown rules
                { type: 'image', regex: /^img(\d*)\((.*?)\)/, process: (m: RegExpMatchArray) => ({ content: m[2] }) },
                { type: 'youtube', regex: /^youtube\(([^)]+)\)/, process: (m: RegExpMatchArray) => ({ type: 'link', url: `https://www.youtube.com/watch?v=${m[1]}`, content: `youtube.com/watch?v=${m[1]}` }) },
                { type: 'video', regex: /^video\(([^)]+)\)/, process: (m: RegExpMatchArray) => ({ type: 'link', url: m[1], content: m[1] }) },
                { type: 'link', regex: /^\[([^\]]+)\]\(([^)]+)\)/, process: (m: RegExpMatchArray) => ({ content: m[1], url: m[2] }) },
                { type: 'bold', regex: /^\*\*([\s\S]+?)\*\*|^\_\_([\s\S]+?)\_\_/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1] || m[2]) }) },
                { type: 'italic', regex: /^\*([\s\S]+?)\*|^\_([\s\S]+?)\_/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1] || m[2]) }) },
                { type: 'strike', regex: /^~~([\s\S]+?)~~/, process: (m: RegExpMatchArray) => ({ content: parseInline(m[1]) }) },
                { type: 'spoiler', regex: /^!~(.+?)~!/, process: (m: RegExpMatchArray) => ({ content: m[1] }) },
                { type: 'spoiler', regex: /^~!([\s\S]+?)!~/, process: (m: RegExpMatchArray) => ({ content: m[1] }) },
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
                        const nextTokenIndex = text.search(/(\[|!~|~!|https?:\/\/|`|\*\*|\*|__|_|~~|img\(|youtube\(|video\(|<[a|img|b])/);
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
                    if (block.type === 'center') {
                         resultSegments.push({ type: 'center', content: parseComment(block.content) });
                    } else if (block.type === 'spoiler') {
                         resultSegments.push({ type: 'spoiler', content: block.content });
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

            const createWrapper = (children: any[], style: object, display: 'inline' | 'block' = 'inline') => {
                 return tray.div(children, { style: { ...style, display } });
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
                    return revealedSpoilers.get()[key]
                        ? tray.div([tray.text({ text: segment.content as string, style: { background: '#2D3748', padding: '2px 4px', borderRadius: '4px', cursor: 'pointer', ...textStyle, display: 'block' } })], { onClick: ctx.eventHandler(key, () => revealedSpoilers.set(s => ({ ...s, [key]: false }))) })
                        : tray.button({ label: "Spoiler", intent: "primary-subtle", size: "sm", onClick: ctx.eventHandler(key, () => revealedSpoilers.set(s => ({ ...s, [key]: true }))) });
                case 'image':
                    const imageUrl = segment.content as string;
                    const linkUrlForImage = segment.url || imageUrl;
                    return tray.stack([
                        tray.div([], { style: { width: '100%', maxWidth: '300px', aspectRatio: '16 / 9', backgroundImage: `url(${imageUrl})`, backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat', borderRadius: '4px', backgroundColor: '#2D3748' } }),
                        tray.flex([
                            tray.text({ text: "Image may not load.", size: "sm", color: "gray" }),
                            tray.button({ label: "Open Link", intent: 'link', size: 'sm', onClick: ctx.eventHandler(`${key}-open`, () => linkToConfirm.set(linkUrlForImage)) })
                        ], { style: { gap: 2, alignItems: 'center', marginTop: '2px' } })
                    ], { style: { gap: 1, marginTop: '4px', display: 'inline-block' } });
                case 'link':
                     const linkContent = segment.content;
                     if(Array.isArray(linkContent) && linkContent.length > 0) {
                        return createWrapper(renderContent(linkContent), { color: '#66b2ff', textDecoration: 'underline', cursor: 'pointer' }, 'inline', { onClick: ctx.eventHandler(key, () => linkToConfirm.set(segment.url!))});
                     }
                    const linkText = (segment.content as string).length > 50 ? (segment.content as string).substring(0, 47) + '...' : (segment.content as string);
                    return tray.button({ label: linkText, intent: 'link', size: 'sm', onClick: ctx.eventHandler(key, () => linkToConfirm.set(segment.url!)) });
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
        const view = ctx.state<'list' | 'thread'>('list');
        const threads = ctx.state<Thread[] | null>(null);
        const selectedThread = ctx.state<Thread | null>(null);
        const comments = ctx.state<ThreadComment[] | null>(null);
        const revealedSpoilers = ctx.state<{ [key: string]: boolean }>({});
        const isLoading = ctx.state(false);
        const error = ctx.state<string | null>(null);
        const replyingToCommentId = ctx.state<number | null>(null);
        const editingCommentId = ctx.state<number | null>(null);
        const deletingCommentId = ctx.state<number | null>(null);
        const isReplyingToThread = ctx.state(false);
        const isSubmitting = ctx.state(false);
        const replyInputRef = ctx.fieldRef<string>("");
        const editInputRef = ctx.fieldRef<string>("");
        const linkToConfirm = ctx.state<string | null>(null);
        const commentSort = ctx.state<'ID' | 'ID_DESC'>('ID_DESC');
        const commentsPage = ctx.state(1);
        const commentsHasNextPage = ctx.state(false);
        const fetchingMediaId = ctx.state<number | null>(null);
        const selectionState = ctx.state<{ start: number, end: number, text: string } | null>(null);


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
            fetchThreads: async function(mediaId: number) {
                const query = `query ($mediaCategoryId: Int) { Page(page: 1, perPage: 50) { threads(mediaCategoryId: $mediaCategoryId, sort: [REPLY_COUNT_DESC]) { id, title, body, createdAt, replyCount, siteUrl, repliedAt, user { name, avatar { large } }, replyUser { name } } } }`;
                const data = await this._fetch(query, { mediaCategoryId: mediaId });
                return (data.Page.threads || []).map((thread: any) => {
                    const match = thread.title.match(/Episode (\d+)/i);
                    return { ...thread, isEpisode: !!match, episodeNumber: match ? parseInt(match[1], 10) : 0 };
                });
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

        const fetchThreads = async (mediaId: number) => {
            if (fetchingMediaId.get() === mediaId) return;

            fetchingMediaId.set(mediaId);
            isLoading.set(true);
            threads.set(null);
            error.set(null);

            try {
                const processedThreads = await anilistApi.fetchThreads(mediaId);
                if (fetchingMediaId.get() === mediaId) {
                    threads.set(processedThreads);
                }
            } catch (e: any) {
                if (fetchingMediaId.get() === mediaId) {
                    error.set(e.message);
                }
            } finally {
                if (fetchingMediaId.get() === mediaId) {
                    isLoading.set(false);
                    fetchingMediaId.set(null);
                }
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
            deletingCommentId.set(null);

            try {
                const success = await anilistApi.deleteComment(commentId);
                if (!success) throw new Error("Deletion failed on server.");
            } catch (e: any) {
                error.set("Failed to delete comment. Please refresh.");
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
                fetchThreads(mediaId);
            }
        });

        tray.onClose(() => {
            linkToConfirm.set(null);
        });

        ctx.effect(() => { if (selectedThread.get()) fetchComments(selectedThread.get()!.id, 1); }, [selectedThread, commentSort]);

        ctx.registerEventHandler('inputSelectionChange', (e: { cursorStart: number, cursorEnd: number, selectedText: string }) => {
            selectionState.set({ start: e.cursorStart, end: e.cursorEnd, text: e.selectedText });
        });

        ctx.registerEventHandler("back-to-list", () => {
            view.set('list'); selectedThread.set(null); comments.set(null); revealedSpoilers.set({}); replyingToCommentId.set(null); editingCommentId.set(null); deletingCommentId.set(null); isReplyingToThread.set(false); commentsPage.set(1); commentsHasNextPage.set(false);
        });
        ctx.registerEventHandler("cancel-reply", () => { replyingToCommentId.set(null); isReplyingToThread.set(false); replyInputRef.setValue(""); });
        ctx.registerEventHandler("cancel-edit", () => { editingCommentId.set(null); editInputRef.setValue(""); });
        ctx.registerEventHandler("cancel-delete", () => { deletingCommentId.set(null); });
        ctx.registerEventHandler("load-more-comments", () => { if (selectedThread.get()) fetchComments(selectedThread.get()!.id, commentsPage.get() + 1); });

        // --- REVISED ---
        // This is the main fix. This function now correctly wraps selected text.
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
                if (selected) { // If text is selected, wrap it.
                    newText = before + prefix + selected + suffix + after;
                } else { // If no text is selected, insert characters at the cursor.
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
                        tray.div([], { style: { height: '14px', width: '50%', backgroundColor: '#2D3748', borderRadius: '4px', marginTop: '4px' } })
                    ], { style: { flexGrow: 1, gap: 1 } })
                ], { style: { gap: 3, alignItems: 'center' } })
            ], { style: { padding: '10px 5px', borderBottom: '1px solid #2D3748', opacity: 0.5 }});
        }

        // --- UI RENDERING ---
        tray.render(() => {
            const centralMessage = (text: string) => tray.stack([tray.text(text)], { style: { height: '100%', alignItems: 'center', justifyContent: 'center' } });

            const mainContent = (() => {
                if (!currentMediaId.get()) return centralMessage("Navigate to an anime to see discussions.");

                if (isLoading.get() && !threads.get()) {
                     return tray.stack([
                        tray.text({ text: "Episode Discussions", size: "lg", align: "center", weight: "semibold" }),
                        tray.flex(Array(8).fill(0).map(() => tray.div([], { style: { width: '40px', height: '30px', backgroundColor: '#2D3748', borderRadius: '4px' } })), { style: { gap: 2, flexWrap: 'wrap', justifyContent: 'center', marginTop: '8px', opacity: 0.5 } }),
                        tray.div([], { style: { borderTop: '1px solid #2D3748', marginTop: '10px', marginBottom: '10px' } }),
                        tray.text({ text: "General Discussions", size: "lg", align: "center", weight: "semibold" }),
                        ...Array(5).fill(0).map(() => renderThreadSkeleton())
                    ], { style: { height: '100%', padding: '0 10px' } });
                }

                if (error.get()) return centralMessage(error.get()!);

                const me = currentUser.get();
                const renderComment = (comment: ThreadComment) => {
                    const isEditingThisComment = editingCommentId.get() === comment.id;
                    const isDeletingThisComment = deletingCommentId.get() === comment.id;

                    if (isDeletingThisComment) {
                        return tray.div([
                            tray.flex([
                                tray.text("Are you sure?"),
                                tray.button({ label: "Yes", intent: "alert", onClick: ctx.eventHandler(`confirm-delete-${comment.id}`, () => handleDeleteComment(comment.id)) }),
                                tray.button({ label: "No", intent: "gray", onClick: "cancel-delete" })
                            ], { style: { gap: 3, alignItems: 'center', justifyContent: 'center' } })
                        ], { style: { borderTop: '1px solid #2D3748', paddingTop: '12px', marginTop: '12px' } });
                    }

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
                        tray.button({ label: `Reply`, intent: 'gray-subtle', size: 'sm', onClick: ctx.eventHandler(`reply-to-comment-${comment.id}`, () => { replyingToCommentId.set(comment.id); editingCommentId.set(null); deletingCommentId.set(null); isReplyingToThread.set(false); replyInputRef.setValue(""); })})
                    ];
                    if (me && comment.user.name === me.name) {
                        actionButtons.push(tray.button({ label: 'Edit', intent: 'gray-subtle', size: 'sm', onClick: ctx.eventHandler(`edit-comment-${comment.id}`, () => { editingCommentId.set(comment.id); editInputRef.setValue(comment.comment.replace(/<br>/g, '\n')); replyingToCommentId.set(null); deletingCommentId.set(null); isReplyingToThread.set(false); })}));
                        actionButtons.push(tray.button({ label: 'Delete', intent: 'alert-subtle', size: 'sm', onClick: ctx.eventHandler(`delete-comment-${comment.id}`, () => { deletingCommentId.set(comment.id); editingCommentId.set(null); replyingToCommentId.set(null); isReplyingToThread.set(false); })}));
                    }

                    return tray.div([
                        tray.flex([
                            tray.div([], { style: { width: '36px', height: '36px', borderRadius: '50%', backgroundImage: `url(${comment.user.avatar.large})`, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 } }),
                            tray.stack([
                                tray.flex([
                                    tray.text({ text: comment.user.name, weight: "semibold", style: { whiteSpace: 'nowrap' } }),
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

                if (view.get() === 'thread' && selectedThread.get()) {
                    const thread = selectedThread.get()!;
                    const opSegments = parseComment(thread.body);
                    const currentComments = comments.get();

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
                                                tray.text({ text: thread.user.name, weight: "semibold", style: { whiteSpace: 'nowrap' } }),
                                                tray.text({ text: formatTimeAgo(thread.createdAt), size: "sm", color: "gray", style: { fontStyle: 'italic', marginLeft: '8px', whiteSpace: 'nowrap' } })
                                            ], { style: { alignItems: 'baseline', alignSelf: 'flex-start' } }),
                                            tray.div(opSegments.map((segment, index) => renderSegment(segment, `op-${index}`)), { style: { display: 'block'} }),
                                        ], { style: { flexGrow: 1, gap: 1, minWidth: 0 } })
                                    ], { style: { gap: 3, alignItems: 'start' } })
                                ], { style: { padding: '12px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', marginTop: '12px' } }),

                                tray.div([], { style: { borderTop: '1px solid #2D3748', marginTop: '20px', marginBottom: '10px' } }),
                                tray.flex([
                                    tray.button({ label: "Post a new comment", intent: "primary", onClick: ctx.eventHandler(`reply-to-thread`, () => { isReplyingToThread.set(!isReplyingToThread.get()); replyingToCommentId.set(null); editingCommentId.set(null); deletingCommentId.set(null); }) }),
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

                const threadList = threads.get();
                if (threadList) {
                    return tray.stack([
                        tray.div([
                            tray.stack([
                                tray.text({ text: "Episode Discussions", size: "lg", align: "center", weight: "semibold" }),
                                tray.flex(
                                    threadList.filter(t => t.isEpisode).sort((a, b) => a.episodeNumber - b.episodeNumber).map(thread =>
                                        tray.button({ label: `${thread.episodeNumber}`, intent: "primary-subtle", style: { minWidth: '40px', justifyContent: 'center' }, onClick: ctx.eventHandler(`select-thread-ep-${thread.id}`, () => { comments.set(null); isLoading.set(true); selectedThread.set(thread); view.set('thread'); }) })
                                    ),
                                    { style: { gap: 2, flexWrap: 'wrap', justifyContent: 'center', marginTop: '8px' } }
                                ),
                                ...(threadList.filter(t => !t.isEpisode).length > 0 ? [tray.div([], { style: { borderTop: '1px solid #2D3748', marginTop: '10px', marginBottom: '10px' } })] : []),
                                ...(threadList.filter(t => !t.isEpisode).length > 0 ? [tray.text({ text: "General Discussions", size: "lg", align: "center", weight: "semibold" })] : []),
                                ...threadList.filter(t => !t.isEpisode).map(thread =>
                                    tray.stack([
                                        tray.flex([
                                            tray.div([], { style: { width: '40px', height: '40px', borderRadius: '50%', backgroundImage: `url(${thread.user.avatar.large})`, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 } }),
                                            tray.stack([
                                                tray.text({ text: thread.title, weight: 'semibold' }),
                                                tray.text({ text: `Created by ${thread.user.name} · ${thread.replyCount} replies · Last by ${thread.replyUser?.name || 'N/A'} ${formatTimeAgo(thread.repliedAt)}`, size: 'sm', color: 'gray' })
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
                                )
                            ], {})
                        ], { style: { flexGrow: 1, overflowY: 'auto' } })
                    ], { style: { height: '100%', display: 'flex', flexDirection: 'column' } });
                }
                return centralMessage("No discussions found for this entry.");
            })();

            const urlToConfirm = linkToConfirm.get();
            return tray.div([
                mainContent,
                ...(urlToConfirm ? [
                    tray.div([
                        tray.button({
                            label: " ",
                            onClick: ctx.eventHandler('close-modal-backdrop', () => linkToConfirm.set(null)),
                            style: {
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '100%',
                                background: 'transparent',
                                border: 'none',
                                zIndex: 0,
                                cursor: 'default',
                            }
                        }),
                        tray.div([
                            tray.stack([
                                tray.text({ text: "Open external link?", weight: 'semibold', size: 'lg'}),
                                tray.text({ text: urlToConfirm, size: "sm", color: "gray", style: { wordBreak: 'break-all' } }),
                                tray.flex([
                                     tray.div([
                                        tray.anchor({
                                            text: "Open",
                                            href: urlToConfirm,
                                            target: "_blank",
                                            className: "bg-red-600 hover:bg-red-700 text-white font-medium text-sm rounded-md px-4 py-2 transition-colors no-underline inline-flex items-center justify-center",
                                        })
                                    ], { onClick: ctx.eventHandler('confirm-open-link', () => {
                                            ctx.setTimeout(() => {
                                                linkToConfirm.set(null);
                                            }, 150);
                                        })
                                    }),
                                    tray.button({
                                        label: "Cancel",
                                        intent: "gray",
                                        onClick: ctx.eventHandler('cancel-open-link', () => { linkToConfirm.set(null); }),
                                    })
                                ], { style: { gap: 2, justifyContent: 'center', marginTop: '12px' }})
                            ], { style: { gap: 2, alignItems: 'center' }})
                        ], {
                            style: {
                                background: '#111827',
                                border: '1px solid #374151',
                                padding: '20px',
                                borderRadius: '8px',
                                boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
                                minWidth: '300px',
                                maxWidth: '90%',
                                position: 'relative',
                                zIndex: 1,
                            },
                            onClick: ctx.eventHandler('dialog-click-trap', () => {})
                        })
                    ], {
                        style: {
                            position: 'fixed',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            background: 'rgba(0, 0, 0, 0.7)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            zIndex: 100
                        },
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
                    threads.set(null);
                    comments.set(null);
                    selectedThread.set(null);
                    view.set('list');
                    revealedSpoilers.set({});
                    replyingToCommentId.set(null);
                    editingCommentId.set(null);
                    deletingCommentId.set(null);
                    isReplyingToThread.set(false);
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
