/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./core.d.ts" />

// Interfaces to define our data structures
interface Thread {
    id: number; title: string; replyCount: number; isEpisode: boolean; episodeNumber: number; siteUrl: string;
}
interface User {
    name: string;
    avatar: { large: string; };
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
    type: 'text' | 'spoiler'; content: string;
}

function init() {
    $ui.register((ctx) => {
    
        // --- HELPER FUNCTIONS ---
        function cleanCommentText(text: string): string {
            if (!text) return '';
            return text.replace(/<br>/g, '\n').replace(/~!.*?~>/g, '[Spoiler]').replace(/img\d*\([^)]+\)/g, '[Image]').replace(/<[^>]*>/g, '');
        }
        function parseComment(text: string): CommentSegment[] {
            if (!text) return [];
            const segments: CommentSegment[] = [];
            const spoilerRegex = /~!(.*?)!~/gs;
            let lastIndex = 0; let match;
            while ((match = spoilerRegex.exec(text)) !== null) {
                if (match.index > lastIndex) segments.push({ type: 'text', content: text.substring(lastIndex, match.index) });
                segments.push({ type: 'spoiler', content: match[1] });
                lastIndex = match.index + match[0].length;
            }
            if (lastIndex < text.length) segments.push({ type: 'text', content: text.substring(lastIndex) });
            return segments;
        }
        function formatTimeAgo(timestamp: number): string {
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

        // --- DATA FETCHING & MUTATIONS ---
        const fetchViewer = async () => {
            if (currentUser.get()) return;
            try {
                const query = `query { Viewer { name, avatar { large } } }`;
                const token = $database.anilist.getToken();
                if (!token) return;
                const res = await ctx.fetch("https://graphql.anilist.co", { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: { query } });
                if (!res.ok) throw new Error(`API returned status ${res.status}`);
                const json = await res.json();
                if (json.data.Viewer) currentUser.set(json.data.Viewer);
            } catch (e: any) { console.error("Failed to fetch viewer info:", e.message); }
        };

        const fetchThreads = async (mediaId: number) => {
            if (threads.get() !== null && !isLoading.get()) return;
            isLoading.set(true); error.set(null);
            try {
                const query = `query ($mediaCategoryId: Int) { Page(page: 1, perPage: 50) { threads(mediaCategoryId: $mediaCategoryId, sort: [REPLY_COUNT_DESC]) { id, title, replyCount, siteUrl } } }`;
                const token = $database.anilist.getToken();
                if (!token) throw new Error("AniList token not found.");
                const res = await ctx.fetch("https://graphql.anilist.co", {
                    method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: { query, variables: { mediaCategoryId: mediaId } }
                });
                if (!res.ok) throw new Error(`API returned status ${res.status}`);
                const json = await res.json();
                if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join(', '));
                const processedThreads = (json.data.Page.threads || []).map((thread: any) => {
                    const match = thread.title.match(/Episode (\d+)/i);
                    return { ...thread, isEpisode: !!match, episodeNumber: match ? parseInt(match[1], 10) : 0 };
                });
                threads.set(processedThreads);
            } catch (e: any) { error.set(e.message); }
            finally { isLoading.set(false); }
        };
        
        const fetchComments = async (threadId: number) => {
            isLoading.set(true); error.set(null); comments.set(null);
            try {
                const query = `query ($threadId: Int) { Page(page: 1, perPage: 50) { threadComments(threadId: $threadId, sort: ID) { id, comment, createdAt, likeCount, isLiked, user { name, avatar { large } }, childComments } } }`;
                const token = $database.anilist.getToken();
                if (!token) throw new Error("AniList token not found.");
                const res = await ctx.fetch("https://graphql.anilist.co", {
                    method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: { query, variables: { threadId: threadId } }
                });
                if (!res.ok) throw new Error(`API returned status ${res.status}`);
                const json = await res.json();
                if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join(', '));
                const parsedComments = json.data.Page.threadComments.map((comment: any) => ({ ...comment, childComments: comment.childComments || [] }));
                comments.set(parsedComments || []);
            } catch (e: any) { error.set(e.message); }
            finally { isLoading.set(false); }
        };

        const handleToggleLike = (commentId: number) => {
            const updateCommentInTree = (commentList: ThreadComment[]): ThreadComment[] => {
                return commentList.map(comment => {
                    if (comment.id === commentId) {
                        return { ...comment, isLiked: !comment.isLiked, likeCount: comment.isLiked ? comment.likeCount - 1 : comment.likeCount + 1 };
                    }
                    if (comment.childComments && comment.childComments.length > 0) {
                        return { ...comment, childComments: updateCommentInTree(comment.childComments) };
                    }
                    return comment;
                });
            };
            comments.set(updateCommentInTree(comments.get() || []));

            const mutation = `mutation ($id: Int, $type: LikeableType) { ToggleLikeV2(id: $id, type: $type) { ... on ThreadComment { id } } }`;
            const token = $database.anilist.getToken();
            if (token) {
                ctx.fetch("https://graphql.anilist.co", {
                    method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: { query: mutation, variables: { id: commentId, type: "THREAD_COMMENT" } }
                }).catch(e => console.error("Like mutation failed:", e));
            }
        };

        const handlePostReply = (text: string, parentCommentId?: number) => {
            const threadId = selectedThread.get()?.id;
            if (!threadId || !text || isSubmitting.get()) return;

            isSubmitting.set(true);
            error.set(null);
            
            const me = currentUser.get();
            if (!me) { error.set("Cannot post reply, user data not loaded."); isSubmitting.set(false); return; }

            const temporaryId = Date.now();
            const newComment: ThreadComment = {
                id: temporaryId,
                comment: text,
                createdAt: Math.floor(Date.now() / 1000),
                likeCount: 0,
                isLiked: false,
                user: me,
                childComments: [],
                isOptimistic: true,
            };

            const addReplyToTree = (commentList: ThreadComment[], pId: number): ThreadComment[] => {
                return commentList.map(comment => {
                    if (comment.id === pId) return { ...comment, childComments: [...(comment.childComments || []), newComment] };
                    if (comment.childComments) return { ...comment, childComments: addReplyToTree(comment.childComments, pId) };
                    return comment;
                });
            };

            const currentComments = comments.get() || [];
            if (parentCommentId) {
                comments.set(addReplyToTree(currentComments, parentCommentId));
            } else {
                comments.set([newComment, ...currentComments]);
            }
            
            const mutation = `mutation ($threadId: Int!, $parentCommentId: Int, $comment: String) { SaveThreadComment(threadId: $threadId, parentCommentId: $parentCommentId, comment: $comment) { id, comment, createdAt, likeCount, isLiked, user { name, avatar { large } } } }`;
            const token = $database.anilist.getToken();
            
            const variables: { threadId: number; comment: string; parentCommentId?: number } = {
                threadId: threadId,
                comment: text,
            };
            if (parentCommentId) {
                variables.parentCommentId = parentCommentId;
            }

            if (token) {
                ctx.fetch("https://graphql.anilist.co", {
                    method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: { query: mutation, variables: variables }
                })
                .then(res => res.json())
                .then(json => {
                    if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join(', '));
                    const realComment = json.data.SaveThreadComment;
                    const replaceInTree = (commentList: ThreadComment[]): ThreadComment[] => {
                        return commentList.map(comment => {
                            if (comment.id === temporaryId) return { ...realComment, childComments: [] };
                            if (comment.childComments) return { ...comment, childComments: replaceInTree(comment.childComments) };
                            return comment;
                        });
                    };
                    comments.set(replaceInTree(comments.get() || []));
                })
                .catch(e => {
                    error.set("Failed to send reply.");
                    const removeInTree = (commentList: ThreadComment[]): ThreadComment[] => {
                        return commentList.filter(comment => comment.id !== temporaryId).map(comment => {
                            if (comment.childComments) return { ...comment, childComments: removeInTree(comment.childComments) };
                            return comment;
                        });
                    };
                    comments.set(removeInTree(comments.get() || []));
                })
                .finally(() => {
                    isSubmitting.set(false);
                    replyingToCommentId.set(null);
                    isReplyingToThread.set(false);
                    replyInputRef.setValue("");
                });
            }
        };

        const handleEditComment = (commentId: number, newText: string) => {
            const threadId = selectedThread.get()?.id;
            if (!threadId || !newText || isSubmitting.get()) return;

            isSubmitting.set(true);
            error.set(null);

            let originalText = "";
            const findAndUpdateInTree = (commentList: ThreadComment[]): ThreadComment[] => {
                return commentList.map(comment => {
                    if (comment.id === commentId) {
                        originalText = comment.comment;
                        return { ...comment, comment: newText };
                    }
                    if (comment.childComments) {
                        return { ...comment, childComments: findAndUpdateInTree(comment.childComments) };
                    }
                    return comment;
                });
            };
            comments.set(findAndUpdateInTree(comments.get() || []));
            editingCommentId.set(null);

            const mutation = `mutation ($id: Int, $threadId: Int, $comment: String) { SaveThreadComment(id: $id, threadId: $threadId, comment: $comment) { id, comment } }`;
            const token = $database.anilist.getToken();

            if (token) {
                ctx.fetch("https://graphql.anilist.co", {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: { query: mutation, variables: { id: commentId, threadId: threadId, comment: newText } }
                }).then(res => res.json()).then(json => {
                    if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join(', '));
                }).catch(e => {
                    error.set("Failed to edit comment.");
                    const rollbackInTree = (commentList: ThreadComment[]): ThreadComment[] => {
                        return commentList.map(comment => {
                            if (comment.id === commentId) return { ...comment, comment: originalText };
                            if (comment.childComments) return { ...comment, childComments: rollbackInTree(comment.childComments) };
                            return comment;
                        });
                    };
                    comments.set(rollbackInTree(comments.get() || []));
                }).finally(() => {
                    isSubmitting.set(false);
                });
            }
        };
        
        const handleDeleteComment = (commentId: number) => {
            if (isSubmitting.get()) return;
            isSubmitting.set(true);
            error.set(null);

            const removeCommentFromTree = (commentList: ThreadComment[]): ThreadComment[] => {
                return commentList
                    .filter(comment => comment.id !== commentId)
                    .map(comment => {
                        if (comment.childComments) {
                            return { ...comment, childComments: removeCommentFromTree(comment.childComments) };
                        }
                        return comment;
                    });
            };
            comments.set(removeCommentFromTree(comments.get() || []));
            deletingCommentId.set(null);

            const mutation = `mutation ($id: Int) { DeleteThreadComment(id: $id) { deleted } }`;
            const token = $database.anilist.getToken();

            if (token) {
                ctx.fetch("https://graphql.anilist.co", {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: { query: mutation, variables: { id: commentId } }
                }).then(res => res.json()).then(json => {
                    if (json.errors || !json.data.DeleteThreadComment.deleted) {
                        throw new Error(json.errors ? json.errors.map((e: any) => e.message).join(', ') : "Deletion failed on server.");
                    }
                }).catch(e => {
                    error.set("Failed to delete comment. Please refresh.");
                }).finally(() => {
                    isSubmitting.set(false);
                });
            }
        };

        // --- TRAY SETUP & EVENT HANDLING ---
        const tray = ctx.newTray({ tooltipText: "Discussions", iconUrl: "https://raw.githubusercontent.com/5rahim/seanime/main/public/icons/discussion.svg", withContent: true });
        tray.onOpen(() => { fetchViewer(); if (currentMediaId.get()) fetchThreads(currentMediaId.get()!); });
        ctx.effect(() => { if (selectedThread.get()) fetchComments(selectedThread.get()!.id); }, [selectedThread]);
        ctx.registerEventHandler("back-to-list", () => {
            view.set('list'); selectedThread.set(null); comments.set(null); revealedSpoilers.set({}); replyingToCommentId.set(null); editingCommentId.set(null); deletingCommentId.set(null); isReplyingToThread.set(false);
        });
        ctx.registerEventHandler("cancel-reply", () => {
            replyingToCommentId.set(null); isReplyingToThread.set(false); replyInputRef.setValue("");
        });
        ctx.registerEventHandler("cancel-edit", () => {
            editingCommentId.set(null); editInputRef.setValue("");
        });
        ctx.registerEventHandler("cancel-delete", () => {
            deletingCommentId.set(null);
        });

        // --- UI RENDERING ---
        tray.render(() => {
            if (!currentMediaId.get()) return tray.stack([tray.text("Navigate to an anime to see discussions.")]);
            if (isLoading.get() && !threads.get()) return tray.stack([tray.text("Loading...")]);
            if (error.get()) return tray.stack([tray.text(error.get()!)]);
            
            const me = currentUser.get();
            const renderComment = (comment: ThreadComment) => {
                const isEditingThisComment = editingCommentId.get() === comment.id;
                const isDeletingThisComment = deletingCommentId.get() === comment.id;

                if (isDeletingThisComment) {
                    return tray.div([
                        tray.flex([
                            tray.text("Are you sure you want to delete this comment?"),
                            tray.button({ label: "Yes", intent: "alert", onClick: ctx.eventHandler(`confirm-delete-${comment.id}`, () => handleDeleteComment(comment.id)) }),
                            tray.button({ label: "No", intent: "gray", onClick: "cancel-delete" })
                        ], { style: { gap: 3, alignItems: 'center', justifyContent: 'center' } })
                    ], { style: { borderTop: '1px solid #333', paddingTop: '10px', marginTop: '10px' } });
                }

                if (isEditingThisComment) {
                    return tray.div([
                        tray.stack([
                            tray.input({ placeholder: "Edit your comment...", fieldRef: editInputRef }),
                            tray.flex([
                                tray.button({ label: isSubmitting.get() ? "Saving..." : "Save", intent: "primary", disabled: isSubmitting.get(), onClick: ctx.eventHandler(`save-edit-${comment.id}`, () => handleEditComment(comment.id, editInputRef.current!)) }),
                                tray.button({ label: "Cancel", intent: "gray", onClick: "cancel-edit" })
                            ], { style: { gap: 2, justifyContent: 'flex-end' }})
                        ], { style: { marginTop: '8px' }})
                    ], { style: { borderTop: '1px solid #333', paddingTop: '10px', marginTop: '10px' } });
                }

                const segments = parseComment(comment.comment.replace(/<br>/g, '\n'));
                const actionButtons = [
                    tray.button({ label: `♥ ${comment.likeCount}`, intent: comment.isLiked ? 'primary' : 'gray-subtle', size: 'sm', onClick: ctx.eventHandler(`like-comment-${comment.id}`, () => handleToggleLike(comment.id)) }),
                    tray.button({ label: `Reply`, intent: 'gray-subtle', size: 'sm', onClick: ctx.eventHandler(`reply-to-comment-${comment.id}`, () => { replyingToCommentId.set(comment.id); editingCommentId.set(null); deletingCommentId.set(null); isReplyingToThread.set(false); replyInputRef.setValue(""); })})
                ];
                if (me && comment.user.name === me.name) {
                    actionButtons.push(tray.button({ label: 'Edit', intent: 'gray-subtle', size: 'sm', onClick: ctx.eventHandler(`edit-comment-${comment.id}`, () => {
                        editingCommentId.set(comment.id);
                        editInputRef.setValue(comment.comment.replace(/<br>/g, '\n'));
                        replyingToCommentId.set(null);
                        deletingCommentId.set(null);
                        isReplyingToThread.set(false);
                    })}));
                    actionButtons.push(tray.button({ label: 'Delete', intent: 'alert-subtle', size: 'sm', onClick: ctx.eventHandler(`delete-comment-${comment.id}`, () => {
                        deletingCommentId.set(comment.id);
                        editingCommentId.set(null);
                        replyingToCommentId.set(null);
                        isReplyingToThread.set(false);
                    })}));
                }

                return tray.div([
                    tray.flex([
                        tray.div([], { style: { width: '36px', height: '36px', borderRadius: '50%', backgroundImage: `url(${comment.user.avatar.large})`, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 } }),
                        tray.stack([
                            tray.flex([
                                tray.text({ text: comment.user.name, weight: "semibold" }),
                                tray.text({ text: formatTimeAgo(comment.createdAt), size: "sm", color: "gray", style: { fontStyle: 'italic', marginLeft: '8px' } })
                            ], { style: { alignItems: 'baseline', alignSelf: 'flex-start' } }),
                            tray.flex(segments.map((segment, index) => {
                                const spoilerId = `${comment.id}-${index}`;
                                if (segment.type === 'spoiler') {
                                    return revealedSpoilers.get()[spoilerId]
                                        ? tray.text({ text: segment.content, style: { background: '#2D3748', padding: '2px 4px', borderRadius: '4px' } })
                                        : tray.button({ label: "[Spoiler]", intent: "primary-subtle", size: "sm", onClick: ctx.eventHandler(spoilerId, () => revealedSpoilers.set(s => ({ ...s, [spoilerId]: true }))) });
                                } return tray.text(segment.content);
                            }), { style: { flexWrap: 'wrap', alignItems: 'center', gap: 1 } }),
                            tray.flex(actionButtons, { style: { gap: 2, marginTop: '4px' } })
                        ], { style: { flexGrow: 1, gap: 1 } })
                    ], { style: { gap: 3, alignItems: 'start' } }),
                    
                    ...(replyingToCommentId.get() === comment.id ? [
                        tray.stack([
                            tray.input({ placeholder: "Write a reply...", fieldRef: replyInputRef }),
                            tray.flex([
                                tray.button({ label: isSubmitting.get() ? "Sending..." : "Send", intent: "primary", disabled: isSubmitting.get(), onClick: ctx.eventHandler(`send-reply-${comment.id}`, () => handlePostReply(replyInputRef.current!, comment.id)) }),
                                tray.button({ label: "Cancel", intent: "gray", onClick: "cancel-reply" })
                            ], { style: { gap: 2, justifyContent: 'flex-end' }})
                        ], { style: { marginTop: '8px', marginLeft: '40px' }})
                    ] : []),

                    ...(comment.childComments && comment.childComments.length > 0 ?
                        [tray.div(comment.childComments.map(child => renderComment(child)), { style: { marginLeft: '20px', borderLeft: '2px solid #4A5568', paddingLeft: '10px' } })]
                        : [])
                ], { style: { borderTop: '1px solid #333', paddingTop: '10px', marginTop: '10px', opacity: comment.isOptimistic ? 0.6 : 1 } });
            };

            if (view.get() === 'thread' && selectedThread.get()) {
                const thread = selectedThread.get()!;
                return tray.stack([
                    tray.flex([
                        tray.button({ label: "< Back", intent: "primary-subtle", size: "sm", onClick: "back-to-list" }),
                        tray.button({
                            label: "Open in Browser 🔗",
                            intent: "primary-subtle",
                            size: "sm",
                            onClick: ctx.eventHandler(`open-browser-${thread.id}`, () => {
                                if (thread.siteUrl) {
                                    try {
                                        let command: string;
                                        let args: string[];
                                        if ($os.platform === 'windows') {
                                            command = 'cmd';
                                            args = ['/C', 'start', thread.siteUrl];
                                        } else if ($os.platform === 'darwin') {
                                            command = 'open';
                                            args = [thread.siteUrl];
                                        } else {
                                            command = 'xdg-open';
                                            args = [thread.siteUrl];
                                        }
                                        const cmd = $osExtra.asyncCmd(command, ...args);
                                        cmd.run(() => {});
                                    } catch (e: any) {
                                        error.set("Failed to open URL. " + e.message);
                                    }
                                }
                            })
                        })
                    ], { style: { justifyContent: 'space-between', alignItems: 'center' } }),
                    tray.text({ text: thread.title, weight: "semibold", size: "lg", align: "center" }),
                    tray.div([], { style: { borderTop: '1px solid #333', marginTop: '10px', marginBottom: '10px' } }),

                    isReplyingToThread.get()
                        ? tray.stack([
                            tray.input({ placeholder: "Write a new comment...", fieldRef: replyInputRef }),
                            tray.flex([
                                tray.button({ label: isSubmitting.get() ? "Sending..." : "Post Comment", intent: "primary", disabled: isSubmitting.get(), onClick: ctx.eventHandler(`send-reply-thread`, () => handlePostReply(replyInputRef.current!)) }),
                                tray.button({ label: "Cancel", intent: "gray", onClick: "cancel-reply" })
                            ], { style: { gap: 2, justifyContent: 'flex-end' }})
                        ], { style: { marginTop: '8px' }})
                        : tray.button({ label: "Post a new comment", intent: "primary-subtle", onClick: ctx.eventHandler(`reply-to-thread`, () => {
                            isReplyingToThread.set(true); replyingToCommentId.set(null); editingCommentId.set(null); deletingCommentId.set(null);
                        }) }),

                    isLoading.get() && !comments.get() ? tray.text("Loading comments...") : (comments.get() ? comments.get()!.map(comment => renderComment(comment)) : tray.text("No comments found."))
                ]);
            }

            const threadList = threads.get();
            if (threadList) {
                const episodeThreads = threadList.filter(t => t.isEpisode).sort((a, b) => a.episodeNumber - b.episodeNumber);
                const generalThreads = threadList.filter(t => !t.isEpisode);
                
                return tray.stack([
                    tray.text({ text: "Episode Discussions", size: "lg", align: "center", weight: "semibold" }),
                    ...episodeThreads.map(thread =>
                        tray.button({
                            label: `Episode ${thread.episodeNumber} Discussion`, intent: "primary-subtle",
                            onClick: ctx.eventHandler(`select-thread-${thread.id}`, () => { selectedThread.set(thread); view.set('thread'); })
                        })
                    ),
                    ...(generalThreads.length > 0 ? [tray.div([], { style: { borderTop: '1px solid #333', marginTop: '10px', marginBottom: '10px' } })] : []),
                    ...(generalThreads.length > 0 ? [tray.text({ text: "General Discussions", size: "lg", align: "center", weight: "semibold" })] : []),
                    ...generalThreads.map(thread =>
                        tray.button({
                            label: `(${thread.replyCount}) ${thread.title}`, intent: "primary-subtle",
                            onClick: ctx.eventHandler(`select-thread-${thread.id}`, () => { selectedThread.set(thread); view.set('thread'); })
                        })
                    )
                ]);
            }
            return tray.stack([tray.text("No discussions found for this entry.")]);
        });
        
        // --- NAVIGATION ---
        ctx.screen.onNavigate((e) => {
            if (e.pathname === "/entry" && !!e.searchParams.id) {
                const id = parseInt(e.searchParams.id);
                if (currentMediaId.get() !== id) {
                    currentMediaId.set(id);
                    threads.set(null); comments.set(null); selectedThread.set(null); view.set('list'); revealedSpoilers.set({}); replyingToCommentId.set(null); editingCommentId.set(null); deletingCommentId.set(null); isReplyingToThread.set(false);
                }
            } else {
                currentMediaId.set(null);
            }
        });
        ctx.screen.loadCurrent();
    });
}