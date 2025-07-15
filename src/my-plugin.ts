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
    title: string;
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
    type: 'text' | 'spoiler' | 'image' | 'link' | 'bold' | 'italic' | 'strike' | 'heading' | 'hr' | 'blockquote' | 'inline-code' | 'code-block' | 'br';
    content: string;
}

function init() {
    $ui.register((ctx) => {

        // --- HELPER FUNCTIONS ---

        function openUrlInBrowser(url: string) {
            try {
                let command: string;
                let args: string[];
                if ($os.platform === 'windows') {
                    command = 'cmd';
                    args = ['/C', 'start', url.replace(/&/g, "^&")];
                } else if ($os.platform === 'darwin') {
                    command = 'open';
                    args = [url];
                } else {
                    command = 'xdg-open';
                    args = [url];
                }
                const cmd = $osExtra.asyncCmd(command, ...args);
                cmd.run(() => {});
            } catch (e: any) {
                error.set("Failed to open URL. " + e.message);
            }
        }
        
        function decodeHtmlEntities(text: string): string {
            if (!text) return "";
            // FIX: Use String.fromCodePoint() to correctly handle high-value unicode characters like emojis.
            return text.replace(/&#(\d+);/g, (match, dec) => {
                return String.fromCodePoint(dec);
            }).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
        }

        function parseComment(text: string): CommentSegment[] {
            if (!text) return [];

            const codeBlockRegex = /```([\s\S]*?)```/g;
            const parts = text.split(codeBlockRegex);
            const initialSegments: { text: string, isCode: boolean }[] = [];
            
            for (let i = 0; i < parts.length; i++) {
                if (i % 2 === 1) { 
                    initialSegments.push({ text: parts[i], isCode: true });
                } else if (parts[i]) { 
                    initialSegments.push({ text: parts[i], isCode: false });
                }
            }

            let finalSegments: CommentSegment[] = [];

            initialSegments.forEach(segment => {
                if (segment.isCode) {
                    finalSegments.push({ type: 'code-block', content: segment.text });
                    return;
                }

                const lines = segment.text.split('\n');
                lines.forEach((line, lineIndex) => {
                    if (line.startsWith('# ')) {
                        finalSegments.push({ type: 'heading', content: line.substring(2) });
                    }
                    else if (/^---\s*$/.test(line)) {
                        finalSegments.push({ type: 'hr', content: '' });
                    }
                    else if (line.startsWith('> ')) {
                        finalSegments.push({ type: 'blockquote', content: line.substring(2) });
                    }
                    else {
                        const inlineRegex = /(\_\_(.*?)\_\_)|(_(.*?)_)|(~~(.*?)~~)|(`(.*?)`)|(img\d*\((.*?)\))|(~!(.*?)!~)|(https?:\/\/[^\s<>"'{}|\\^`[\]]+)/g;
                        let lastIndex = 0;
                        let match;
                        while ((match = inlineRegex.exec(line)) !== null) {
                            if (match.index > lastIndex) {
                                finalSegments.push({ type: 'text', content: line.substring(lastIndex, match.index) });
                            }

                            const [_, bold, boldContent, italic, italicContent, strike, strikeContent, inlineCode, inlineCodeContent, img, imgUrl, spoiler, spoilerContent, link] = match;

                            if (bold) finalSegments.push({ type: 'bold', content: boldContent });
                            else if (italic) finalSegments.push({ type: 'italic', content: italicContent });
                            else if (strike) finalSegments.push({ type: 'strike', content: strikeContent });
                            else if (inlineCode) finalSegments.push({ type: 'inline-code', content: inlineCodeContent });
                            else if (img) finalSegments.push({ type: 'image', content: imgUrl });
                            else if (spoiler) finalSegments.push({ type: 'spoiler', content: spoilerContent });
                            else if (link) finalSegments.push({ type: 'link', content: link });

                            lastIndex = match.index + _.length;
                        }
                        if (lastIndex < line.length) {
                            finalSegments.push({ type: 'text', content: line.substring(lastIndex) });
                        }
                    }
                    if (lineIndex < lines.length - 1) {
                         finalSegments.push({ type: 'br', content: '' });
                    }
                });
            });
            return finalSegments;
        }

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
            if (threads.get() !== null && !isLoading.get()) return;
            isLoading.set(true); error.set(null);
            try {
                const processedThreads = await anilistApi.fetchThreads(mediaId);
                threads.set(processedThreads);
            } catch (e: any) { error.set(e.message); }
            finally { isLoading.set(false); }
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
        tray.onOpen(() => { fetchViewer(); if (currentMediaId.get()) fetchThreads(currentMediaId.get()!); });
        ctx.effect(() => { if (selectedThread.get()) fetchComments(selectedThread.get()!.id, 1); }, [selectedThread, commentSort]);
        ctx.registerEventHandler("back-to-list", () => {
            view.set('list'); selectedThread.set(null); comments.set(null); revealedSpoilers.set({}); replyingToCommentId.set(null); editingCommentId.set(null); deletingCommentId.set(null); isReplyingToThread.set(false); commentsPage.set(1); commentsHasNextPage.set(false);
        });
        ctx.registerEventHandler("cancel-reply", () => { replyingToCommentId.set(null); isReplyingToThread.set(false); replyInputRef.setValue(""); });
        ctx.registerEventHandler("cancel-edit", () => { editingCommentId.set(null); editInputRef.setValue(""); });
        ctx.registerEventHandler("cancel-delete", () => { deletingCommentId.set(null); });
        ctx.registerEventHandler("load-more-comments", () => { if (selectedThread.get()) fetchComments(selectedThread.get()!.id, commentsPage.get() + 1); });
        
        function renderToolbar(fieldRef: any) {
            const wrapText = (chars: string, placeholder = "") => {
                let current = fieldRef.current || "";
                let [start, end] = [chars.length / 2, chars.length / 2];
                if (placeholder) {
                     current += placeholder;
                     start = chars.indexOf(placeholder[0]);
                     end = 1;
                }
                fieldRef.setValue(current.slice(0, start) + chars + current.slice(start));
            };
            return tray.flex([
                tray.button({ label: 'B', onClick: ctx.eventHandler('tb-b', () => wrapText('____')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'I', onClick: ctx.eventHandler('tb-i', () => wrapText('__')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'S', onClick: ctx.eventHandler('tb-s', () => wrapText('~~~~')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'H', onClick: ctx.eventHandler('tb-h', () => wrapText('\n# ')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'Link', onClick: ctx.eventHandler('tb-link', () => wrapText('[](url)')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'Quote', onClick: ctx.eventHandler('tb-quote', () => wrapText('\n> ')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'Code', onClick: ctx.eventHandler('tb-code', () => wrapText('``')), size: 'sm', intent: 'gray-subtle' }),
                tray.button({ label: 'Spoiler', onClick: ctx.eventHandler('tb-spoiler', () => wrapText('~!!~')), size: 'sm', intent: 'gray-subtle' }),
            ], { style: { gap: 1, padding: '4px', backgroundColor: '#1A202C', borderRadius: '4px', marginBottom: '4px' } });
        }
        
        function renderSegment(segment: CommentSegment, key: string) {
            const textStyle = { wordBreak: 'normal' as const, overflowWrap: 'break-word' as const };
             switch (segment.type) {
                case 'text': return tray.text({text: segment.content, style: textStyle});
                case 'br': return tray.div([], { style: { height: '0.5em', width: '100%' } }); 
                case 'bold': return tray.text({ text: segment.content, weight: 'bold', style: textStyle });
                case 'italic': return tray.text({ text: segment.content, style: { fontStyle: 'italic', ...textStyle } });
                case 'strike': return tray.text({ text: segment.content, style: { textDecoration: 'line-through', ...textStyle } });
                case 'heading': return tray.text({ text: segment.content, size: 'lg', weight: 'semibold', style: textStyle });
                case 'hr': return tray.div([], { style: { borderTop: '1px solid #4A5568', margin: '8px 0' } });
                case 'blockquote': return tray.div([tray.text({text: segment.content, style:textStyle})], { style: { borderLeft: '3px solid #4A5568', paddingLeft: '8px', color: '#A0AEC0', fontStyle: 'italic' }});
                case 'inline-code': return tray.text({ text: segment.content, style: { fontFamily: 'monospace', backgroundColor: '#2D3748', padding: '2px 4px', borderRadius: '4px', ...textStyle } });
                case 'code-block': return tray.div([tray.text({text: segment.content, style: textStyle})], { style: { fontFamily: 'monospace', backgroundColor: '#1A202C', padding: '8px', borderRadius: '4px', whiteSpace: 'pre-wrap', width: '100%' } });
                case 'spoiler':
                    return revealedSpoilers.get()[key]
                        ? tray.text({ text: segment.content, style: { background: '#2D3748', padding: '2px 4px', borderRadius: '4px', ...textStyle } })
                        : tray.button({ label: "[Spoiler]", intent: "primary-subtle", size: "sm", onClick: ctx.eventHandler(key, () => revealedSpoilers.set(s => ({ ...s, [key]: true }))) });
                case 'image':
                    return tray.stack([
                        tray.div([], { style: { width: '100%', maxWidth: '300px', aspectRatio: '16 / 9', backgroundImage: `url(${segment.content})`, backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat', borderRadius: '4px', backgroundColor: '#2D3748' } }),
                        tray.flex([
                            tray.text({ text: "Image not loading?", size: "sm", color: "gray" }),
                            tray.button({ label: "Open Link", intent: 'link', size: 'sm', onClick: ctx.eventHandler(`${key}-open`, () => linkToConfirm.set(segment.content)) })
                        ], { style: { gap: 2, alignItems: 'center', marginTop: '2px' } })
                    ], { style: { gap: 1, marginTop: '4px' } });
                case 'link':
                    return tray.button({ label: segment.content, intent: 'link', size: 'sm', onClick: ctx.eventHandler(key, () => linkToConfirm.set(segment.content)) });
            }
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
                ], { style: { gap: 3, alignItems: 'center', padding: '10px 0', opacity: 0.5 } })
            ]);
        }
        
        // --- UI RENDERING ---
        tray.render(() => {
            const urlToConfirm = linkToConfirm.get();
            if (urlToConfirm) {
                return tray.div([
                    tray.stack([
                        tray.text({ text: "Open external link?", weight: 'semibold', size: 'lg'}),
                        tray.text({ text: urlToConfirm, size: "sm", color: "gray", style: { wordBreak: 'break-all' } }),
                        tray.flex([
                            tray.button({ label: "Yes, open", intent: "primary", onClick: ctx.eventHandler('confirm-open-link', () => { openUrlInBrowser(urlToConfirm); linkToConfirm.set(null); }) }),
                            tray.button({ label: "Cancel", intent: "gray", onClick: ctx.eventHandler('cancel-open-link', () => { linkToConfirm.set(null); }) })
                        ], { style: { gap: 2, justifyContent: 'center', marginTop: '12px' }})
                    ], { style: { gap: 2, alignItems: 'center' }})
                ], { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '20px' }});
            }

            if (!currentMediaId.get()) return tray.stack([tray.text("Navigate to an anime to see discussions.")]);
            if (isLoading.get() && !threads.get()) return tray.stack([renderThreadSkeleton(), renderThreadSkeleton(), renderThreadSkeleton()]);
            if (error.get()) return tray.stack([tray.text(error.get()!)]);
            
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
                            tray.input({ placeholder: "Edit your comment...", fieldRef: editInputRef, isTextarea: true, rows: 3 }),
                            tray.flex([
                                tray.button({ label: isSubmitting.get() ? "Saving..." : "Save", intent: "primary", disabled: isSubmitting.get(), onClick: ctx.eventHandler(`save-edit-${comment.id}`, () => handleEditComment(comment.id, editInputRef.current!)) }),
                                tray.button({ label: "Cancel", intent: "gray", onClick: "cancel-edit" })
                            ], { style: { gap: 2, justifyContent: 'flex-end' }})
                        ], { style: { marginTop: '8px' }})
                    ], { style: { borderTop: '1px solid #2D3748', paddingTop: '12px', marginTop: '12px' } });
                }
                
                const decodedComment = decodeHtmlEntities(comment.comment);
                const segments = parseComment(decodedComment);

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
                            tray.div(segments.map((segment, index) => renderSegment(segment, `${comment.id}-${index}`)), { style: { flexWrap: 'wrap', alignItems: 'center', gap: '2px', lineHeight: '1.6'} }),
                            tray.flex(actionButtons, { style: { gap: 2, marginTop: '4px' } })
                        ], { style: { flexGrow: 1, gap: 1, minWidth: 0 } })
                    ], { style: { gap: 3, alignItems: 'start' } }),
                    
                    ...(replyingToCommentId.get() === comment.id ? [
                        tray.stack([
                            renderToolbar(replyInputRef),
                            tray.input({ placeholder: "Write a reply...", fieldRef: replyInputRef, isTextarea: true, rows: 3 }),
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
                const opDecodedBody = decodeHtmlEntities(thread.body);
                const opSegments = parseComment(opDecodedBody);
                
                return tray.stack([
                    tray.flex([
                        tray.button({ label: "< Back", intent: "gray-subtle", size: "sm", onClick: "back-to-list" }),
                        tray.button({ label: "Open in Browser 🔗", intent: "gray-subtle", size: "sm", onClick: ctx.eventHandler(`open-browser-${thread.id}`, () => { if (thread.siteUrl) openUrlInBrowser(thread.siteUrl); }) })
                    ], { style: { justifyContent: 'space-between', alignItems: 'center', paddingBottom: '8px', flexShrink: 0 } }),
                    
                    tray.div([
                        tray.text({ text: thread.title, weight: "semibold", size: "xl", align: "center" }),
                        tray.div([
                            tray.flex([
                                tray.div([], { style: { width: '36px', height: '36px', borderRadius: '50%', backgroundImage: `url(${thread.user.avatar.large})`, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 } }),
                                tray.stack([
                                    tray.flex([
                                        tray.text({ text: thread.user.name, weight: "semibold", style: { whiteSpace: 'nowrap' } }),
                                        tray.text({ text: formatTimeAgo(thread.createdAt), size: "sm", color: "gray", style: { fontStyle: 'italic', marginLeft: '8px', whiteSpace: 'nowrap' } })
                                    ], { style: { alignItems: 'baseline', alignSelf: 'flex-start' } }),
                                    tray.div(opSegments.map((segment, index) => renderSegment(segment, `op-${index}`)), { style: { flexWrap: 'wrap', alignItems: 'center', gap: '2px', lineHeight: '1.6'} }),
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
                            tray.input({ placeholder: "Write a new comment...", fieldRef: replyInputRef, isTextarea: true, rows: 4 }),
                            tray.flex([
                                tray.button({ label: isSubmitting.get() ? "Sending..." : "Post Comment", intent: "primary", disabled: isSubmitting.get(), onClick: ctx.eventHandler(`send-reply-thread`, () => handlePostReply(replyInputRef.current!)) }),
                                tray.button({ label: "Cancel", intent: "gray", onClick: "cancel-reply" })
                            ], { style: { gap: 2, justifyContent: 'flex-end' }})
                        ], { style: { marginTop: '8px' }})] : []),
                        
                        isLoading.get() && !comments.get() ? tray.stack([renderCommentSkeleton(), renderCommentSkeleton(), renderCommentSkeleton()]) : (comments.get() ? comments.get()!.map(comment => renderComment(comment)) : tray.text("No comments found.")),
                        
                        ...(commentsHasNextPage.get() ? [tray.button({ label: isLoading.get() ? "Loading..." : "Load More", intent: "primary-subtle", disabled: isLoading.get(), onClick: "load-more-comments", style: { marginTop: '12px' } })] : [])
                    ], { style: { flexGrow: 1, overflowY: 'auto', paddingRight: '8px' } })
                ], { style: { height: '100%', display: 'flex', flexDirection: 'column' } });
            }

            const threadList = threads.get();
            if (threadList) {
                return tray.div([
                    tray.stack([
                        tray.text({ text: "Episode Discussions", size: "lg", align: "center", weight: "semibold" }),
                        tray.flex(
                            threadList.filter(t => t.isEpisode).sort((a, b) => a.episodeNumber - b.episodeNumber).map(thread =>
                                tray.button({ label: `${thread.episodeNumber}`, intent: "primary-subtle", style: { minWidth: '40px', justifyContent: 'center' }, onClick: ctx.eventHandler(`select-thread-ep-${thread.id}`, () => { selectedThread.set(thread); view.set('thread'); }) })
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
                                    onClick: ctx.eventHandler(`select-thread-${thread.id}`, () => {
                                        selectedThread.set(thread);
                                        view.set('thread');
                                    })
                                })
                            ], { 
                                style: { position: 'relative', padding: '10px 5px', borderBottom: '1px solid #2D3748' },
                                hoverStyle: { backgroundColor: 'rgba(255, 255, 255, 0.05)' }
                            })
                        )
                    ])
                ], { style: { height: '100%', overflowY: 'auto', paddingRight: '8px' } });
            }
            return tray.stack([tray.text("No discussions found for this entry.")]);
        });
        
        // --- NAVIGATION ---
        ctx.screen.onNavigate((e) => {
            if (e.pathname === "/entry" && !!e.searchParams.id) {
                const id = parseInt(e.searchParams.id);
                if (currentMediaId.get() !== id) {
                    currentMediaId.set(id);
                    threads.set(null); comments.set(null); selectedThread.set(null); view.set('list'); revealedSpoilers.set({}); replyingToCommentId.set(null); editingCommentId.set(null); deletingCommentId.set(null); isReplyingToThread.set(false); commentsPage.set(1); commentsHasNextPage.set(false);
                }
            } else {
                currentMediaId.set(null);
            }
        });
        ctx.screen.loadCurrent();
    });
}
