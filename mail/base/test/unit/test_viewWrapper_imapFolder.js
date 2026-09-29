/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Test DBViewWrapper against a single imap folder.  Try and test all the
 *  features we can without having a fake newsgroup.  (Some features are
 *  newsgroup specific.)
 */

/* import-globals-from resources/viewWrapperTestUtils.js */
load("resources/viewWrapperTestUtils.js");
initViewWrapperTestUtils({ mode: "imap", offline: false });

var { SyntheticMessageSet } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

add_task(async function test_imap_special_view_threading_persistence() {
  for (const specialView of [
    "specialViewThreadsWithUnread",
    "specialViewWatchedThreadsWithUnread",
  ]) {
    info(`Checking threading persistence for ${specialView}`);
    const folderHandle = await messageInjection.makeEmptyFolder();
    const folder = messageInjection.getRealInjectionFolder(folderHandle);
    const threads = Array.from(
      { length: 3 },
      () => new SyntheticMessageSet(gMessageScenarioFactory.directReply(2))
    );
    const [watchedThread, unreadThread, readThread] = threads;
    for (const messageSet of threads) {
      messageSet.synMessages[0].metaState.read = true;
    }
    readThread.synMessages[1].metaState.read = true;
    await messageInjection.addSetsToFolders([folderHandle], threads);
    const thread = folder.msgDatabase.getThreadContainingMsgHdr(
      watchedThread.getMsgHdr(0)
    );
    folder.msgDatabase.markThreadWatched(
      thread,
      watchedThread.getMsgHdr(0).messageKey,
      true,
      null
    );
    const expectedMessages =
      specialView == "specialViewThreadsWithUnread"
        ? [watchedThread, unreadThread]
        : [watchedThread];

    let viewWrapper = make_view_wrapper();
    await view_open(viewWrapper, folder);
    viewWrapper[specialView] = true;
    Assert.ok(
      viewWrapper.showThreaded,
      "Selecting a thread filter enables threading"
    );
    viewWrapper.showUnthreaded = true;
    verify_messages_in_view(expectedMessages, viewWrapper);
    const savedViewFlags = viewWrapper.dbView.viewFlags;
    const savedViewType = viewWrapper.dbView.viewType;
    viewWrapper.close();
    folder.msgDatabase.forceClosed();

    Assert.equal(
      folder.msgDatabase.dBFolderInfo.viewFlags,
      savedViewFlags,
      "Unthreaded flags reached the folder database on disk"
    );
    viewWrapper = make_view_wrapper();
    await view_open(viewWrapper, folder);
    Assert.ok(
      viewWrapper.showUnthreaded,
      "Reopening preserves unthreaded display"
    );
    Assert.ok(
      viewWrapper[specialView],
      "Reopening preserves the thread filter"
    );
    Assert.equal(viewWrapper.dbView.viewType, savedViewType);
    Assert.equal(viewWrapper.dbView.viewFlags, savedViewFlags);
    verify_messages_in_view(expectedMessages, viewWrapper);
    verify_view_level_histogram(
      { 0: expectedMessages.length * 2 },
      viewWrapper
    );

    viewWrapper.showThreaded = true;
    viewWrapper.close();
    folder.msgDatabase.forceClosed();
    viewWrapper = make_view_wrapper();
    await view_open(viewWrapper, folder);
    Assert.ok(
      viewWrapper.showThreaded,
      "Reopening also preserves threaded display"
    );
    Assert.ok(
      viewWrapper[specialView],
      "Threaded display retains the thread filter"
    );
    verify_view_row_at_index_is_container(viewWrapper, 0);
    viewWrapper.close();
  }
});

/**
 * Create an empty folder, inject messages into it without triggering an
 *  updateFolder, sanity check that we believe there are no messages in the
 *  folder, then enter, making sure we immediately enter and that the view
 *  properly updates to reflect there being the right set of messages.
 * (It will fail to update if the db change listener ended up detaching itself
 *  and not reattaching correctly when the updateFolder completes.)
 */
add_task(
  async function test_enter_imap_folder_requiring_update_folder_immediately() {
    // - create the folder and wait for the IMAP op to complete
    const folderHandle = await messageInjection.makeEmptyFolder();
    const msgFolder = messageInjection.getRealInjectionFolder(folderHandle);

    // - add the messages
    const [msgSet] = await messageInjection.makeNewSetsInFolders(
      [folderHandle],
      [{ count: 1 }],
      true
    );

    const viewWrapper = make_view_wrapper();

    // - make sure we don't know about the message!
    Assert.equal(msgFolder.getTotalMessages(false), 0);

    // - sync open the folder, verify we claim we entered, and make sure it has
    //  nothing in it!
    viewWrapper.listener.pendingLoad = true;
    viewWrapper.open(msgFolder);
    Assert.ok(viewWrapper._enteredFolder);
    verify_empty_view(viewWrapper);

    // Wait for all the messages to load.
    await gMockViewWrapperListener.promise;
    gMockViewWrapperListener.resetPromise();

    // - make sure the view sees the message though...
    verify_messages_in_view(msgSet, viewWrapper);
  }
);
