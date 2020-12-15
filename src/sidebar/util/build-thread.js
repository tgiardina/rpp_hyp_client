/**
 * @typedef {import('../../types/api').Annotation} Annotation
 *
 * @typedef Thread
 * @prop {string} id - The thread's id, which equivalent to the id of its
 *       annotation. For unsaved annotations, the id is derived from the
 *       annotation's local `$tag` property.
 * @prop {Annotation} [annotation] - This thread's annotation. Undefined in cases
 *       when an annotation _should_ exist—it's implied by a reference from
 *       another annotation—but is not present in our collection of annotations.
 *       This can happen when a reply has been deleted, but still has children
 *       that exist.
 * @prop {string} [parent] - The id of this thread's parent. Top-level threads
 *       do not have parents
 * @prop {boolean} visible - Whether this thread should be visible when rendered.
 *       true when the thread's annotation matches current annotation filters.
 * @prop {boolean} collapsed - Whether the replies in this thread should be
 *       rendered as collapsed (when true) or expanded (when false)
 * @prop {Thread[]} children
 * @prop {number} [totalChildren] - Computed count of this thread's immediate
 *       children. This count includes visually-hidden threads. Only present on
 *       the root thread level.
 * @prop {number} replyCount - Computed count of all replies to a thread
 * @prop {number} depth - The thread's depth in the hierarchy
 */

/**
 * Default state for new threads
 */
const DEFAULT_THREAD_STATE = {
  collapsed: false,
  depth: 0,
  visible: true,
  replyCount: 0,
};

/**
 * Returns a persistent identifier for an Annotation.
 * If the Annotation has been created on the server, it will have
 * an id assigned, otherwise we fall back to the local-only '$tag'
 * property.
 *
 * @param {Annotation} annotation
 * @return {string}
 */
function annotationId(annotation) {
  return annotation.id || annotation.$tag;
}

/**
 * Is there a valid path from the thread indicated by `id` to the root thread,
 * with no circular references?
 *
 * @param {string} id - The id of the thread to be verified
 * @param {string} ancestorId - The ancestor of the thread indicated by id that
 *        is to be verified: is it extant and not a circular reference?
 * @return {boolean}
 */
function hasPathToRoot(threads, id, ancestorId) {
  if (!threads[ancestorId] || threads[ancestorId].parent === id) {
    // Thread for ancestor not found, or points at itself: circular reference
    return false;
  } else if (!threads[ancestorId].parent) {
    // Top of the tree: we've made it
    return true;
  }
  return hasPathToRoot(threads, id, threads[ancestorId].parent);
}

/**
 * Link the thread's annotation to its parent
 * @param {Object.<string,Thread>} threads
 * @param {string} id
 * @param {string[]} [parents] - ids of parent annotations, from the
 *        annotation's `references` field. Immediate parent is last entry.
 */
function setParent(threads, id, parents = []) {
  if (threads[id].parent || !parents.length) {
    // Parent already assigned, do not try to change it.
    return;
  }
  const parentId = parents[parents.length - 1];

  if (!threads[parentId]) {
    // Parent does not exist. This may be a reply to an annotation which has
    // been deleted. Create a placeholder Thread with no annotation to
    // represent the missing annotation.
    threads[parentId] = {
      ...DEFAULT_THREAD_STATE,
      children: [],
      id: parentId,
    };
    // Link up this new thread to _its_ parent, which should be the original
    // thread's grandparent
    setParent(threads, parentId, parents.slice(0, -1));
  }

  if (hasPathToRoot(threads, id, parentId)) {
    threads[id].parent = parentId;
    threads[parentId].children.push(threads[id]);
  }
}

/**
 * Creates a thread tree of annotations from a list of annotations.
 *
 * Given a flat list of annotations and replies, this generates a hierarchical
 * thread, using the `references` field of an annotation to link together
 * annotations and their replies. The `references` field is a possibly
 * incomplete ordered list of the parents of an annotation, from furthest to
 * nearest ancestor.
 *
 * @param {Annotation[]} annotations - The input annotations to thread.
 * @return {Thread} - The input annotations threaded into a tree structure.
 */
function threadAnnotations(annotations) {
  /** @type {Object.<string,Thread>} */
  const threads = {};

  // Create a `Thread` for each annotation
  annotations.forEach(annotation => {
    const id = annotationId(annotation);
    threads[id] = {
      ...DEFAULT_THREAD_STATE,
      children: [],
      annotation,
      id,
    };
  });

  // Establish ancestral relationships between annotations
  annotations.forEach(annotation => {
    // Remove references to self from `references` to avoid circular references
    const parents = (annotation.references || []).filter(
      id => id !== annotation.id
    );
    return setParent(threads, annotationId(annotation), parents);
  });

  // Collect the set of threads which have no parent as
  // children of the thread root
  const rootThreads = [];
  for (const rootThreadId in threads) {
    if (!threads[rootThreadId].parent) {
      // Top-level threads are collapsed by default
      threads[rootThreadId].collapsed = true;
      rootThreads.push(threads[rootThreadId]);
    }
  }

  const rootThread = {
    ...DEFAULT_THREAD_STATE,
    id: 'root',
    children: rootThreads,
  };

  return rootThread;
}

/**
 * Returns a copy of `thread` with the thread
 * and each of its children transformed by mapFn(thread).
 *
 * @param {Thread} thread
 * @param {(t: Thread) => Thread} mapFn
 * @return {Thread}
 */
function mapThread(thread, mapFn) {
  return Object.assign({}, mapFn(thread), {
    children: thread.children.map(child => {
      return mapThread(child, mapFn);
    }),
  });
}

/**
 * Return a sorted copy of an array of threads.
 *
 * @param {Thread[]} threads - The list of threads to sort
 * @param {(a: Annotation, b: Annotation) => boolean} compareFn
 * @return {Thread[]} Sorted list of threads
 */
function sort(threads, compareFn) {
  return threads.slice().sort((a, b) => {
    // Threads with no annotation always sort to the top
    if (!a.annotation || !b.annotation) {
      if (!a.annotation && !b.annotation) {
        return 0;
      } else {
        return !a.annotation ? -1 : 1;
      }
    }

    if (compareFn(a.annotation, b.annotation)) {
      return -1;
    } else if (compareFn(b.annotation, a.annotation)) {
      return 1;
    } else {
      return 0;
    }
  });
}

/**
 * Return a new `Thread` object with all (recursive) `children` arrays sorted.
 * Sort the children of top-level threads using `compareFn` and all other
 * children using `replyCompareFn`.
 *
 * @param {Thread} thread
 * @param {(a: Annotation, b: Annotation) => boolean} compareFn - Less-than
 *         comparison function for sorting top-level annotations
 * @param {(a: Annotation, b: Annotation) => boolean} replyCompareFn - Less-than
 *       comparison function for sorting replies
 * @return {Thread}
 */
function sortThread(thread, compareFn, replyCompareFn) {
  const children = thread.children.map(child =>
    sortThread(child, replyCompareFn, replyCompareFn)
  );

  return { ...thread, children: sort(children, compareFn) };
}

/**
 * Return a copy of `thread` with the `replyCount` and `depth` properties
 * updated.
 *
 * @param {Thread} thread
 * @param {number} depth
 * @return {Thread}
 */
function countRepliesAndDepth(thread, depth) {
  const children = thread.children.map(c => countRepliesAndDepth(c, depth + 1));
  const replyCount = children.reduce(
    (total, child) => total + 1 + child.replyCount,
    0
  );
  return {
    ...thread,
    children,
    depth,
    replyCount,
  };
}

/**
 * Does this thread have any visible children?
 *
 * @param {Thread} thread
 * @return {boolean}
 */
function hasVisibleChildren(thread) {
  return thread.children.some(child => {
    return child.visible || hasVisibleChildren(child);
  });
}

/**
 * @typedef Options
 * @prop {string[]} selected - List of currently-selected annotation ids, from
 *       the data store
 * @prop {string[]} forcedVisible - List of $tags of annotations that have
 *       been explicitly expanded by the user, even if they don't
 *       match current filters
 * @prop {(a: Annotation) => boolean} [filterFn] - Predicate function that
 *       returns `true` if annotation should be visible
 * @prop {(t: Thread) => boolean} [threadFilterFn] - Predicate function that
 *       returns `true` if the annotation should be included in the thread tree
 * @prop {Object.<string, boolean>} expanded - Map of thread id => expansion state
 * @prop {(a: Annotation, b: Annotation) => boolean} sortCompareFn - Less-than
 *       comparison function for sorting top-level annotations
 * @prop {(a: Annotation, b: Annotation) => boolean} replySortCompareFn - Less-than
 *       comparison function for sorting replies
 */

/**
 * Default options for buildThread()
 *
 * @type {Options}
 */
const defaultOpts = {
  selected: [],
  expanded: {},
  forcedVisible: [],
  sortCompareFn: (a, b) => {
    return a.$tag < b.$tag;
  },
  replySortCompareFn: (a, b) => {
    return a.created < b.created;
  },
};

/**
 * Project, filter and sort a list of annotations into a thread structure for
 * display by the <Thread> component.
 *
 * buildThread() takes as inputs a flat list of annotations,
 * the current visibility filters and sort function and returns
 * the thread structure that should be rendered.
 *
 * An Annotation present in `annotations` will not be present in the returned threads if:
 * - The annotation does not match thread-level filters (options.threadFilterFn), OR
 * - The annotation is not in the current selection (options.selected), OR
 * - The annotation's thread is hidden and has no visible children
 *
 * Annotations that do not match the currently-applied annotation filters
 * (options.filterFn) will have their thread's `visible` property set to `hidden`
 * (an exception is made if that annotation's thead has been forced visible by
 * a user).
 *
 * @param {Annotation[]} annotations - A list of annotations and replies
 * @param {Partial<Options>} options
 * @return {Thread} - The root thread, whose children are the top-level
 *                    annotations to display.
 */
export default function buildThread(annotations, options) {
  const opts = { ...defaultOpts, ...options };

  const hasSelection = opts.selected.length > 0;
  const hasForcedVisible = opts.forcedVisible.length > 0;

  let thread = threadAnnotations(annotations);

  if (hasSelection) {
    // Remove threads (annotations) that are not selected or
    // are not forced-visible
    thread.children = thread.children.filter(child => {
      const isSelected = opts.selected.includes(child.id);
      const isForcedVisible =
        hasForcedVisible &&
        child.annotation &&
        opts.forcedVisible.includes(child.annotation.$tag);
      return isSelected || isForcedVisible;
    });
  }

  if (opts.threadFilterFn) {
    // Remove threads not matching thread-level filters
    thread.children = thread.children.filter(opts.threadFilterFn);
  }

  // Set visibility for threads
  thread = mapThread(thread, thread => {
    let threadIsVisible = thread.visible;

    if (!thread.annotation) {
      threadIsVisible = false; // Nothing to show
    } else if (opts.filterFn) {
      if (
        hasForcedVisible &&
        opts.forcedVisible.includes(thread.annotation.$tag)
      ) {
        // This annotation may or may not match the filter, but we should
        // make sure it is visible because it has been forced visible by user
        threadIsVisible = true;
      } else {
        // Otherwise, visibility depends on whether it matches the filter
        threadIsVisible = !!opts.filterFn(thread.annotation);
      }
    }
    return { ...thread, visible: threadIsVisible };
  });

  // Remove top-level threads which contain no visible annotations
  thread.children = thread.children.filter(
    child => child.visible || hasVisibleChildren(child)
  );

  // Determine collapsed state for UI
  thread = mapThread(thread, thread => {
    const threadStates = {
      collapsed: thread.collapsed,
    };

    if (opts.expanded.hasOwnProperty(thread.id)) {
      // This thread has been explicitly expanded/collapsed by user
      threadStates.collapsed = !opts.expanded[thread.id];
    } else {
      // If annotations are filtered, and at least one child matches
      // those filters, make sure thread is not collapsed
      const hasUnfilteredChildren = opts.filterFn && hasVisibleChildren(thread);
      threadStates.collapsed = thread.collapsed && !hasUnfilteredChildren;
    }
    return { ...thread, ...threadStates };
  });

  // Sort the root thread according to the current search criteria
  thread = sortThread(thread, opts.sortCompareFn, opts.replySortCompareFn);

  // Update `replyCount` and `depth` properties
  thread = countRepliesAndDepth(thread, -1);

  thread.totalChildren = thread.children.length;

  return thread;
}
