/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

const dragService = Cc["@mozilla.org/widget/dragservice;1"].getService(
  Ci.nsIDragService
);

const about3Pane = document.getElementById("tabmail").currentAbout3Pane;
const { folderPane, folderTree } = about3Pane;
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

let rootFolder,
  outboxFolder,
  trashFolder,
  folderA,
  folderB,
  folderC,
  result,
  dataTransfer;

add_setup(async function () {
  Services.prefs.setIntPref("ui.prefersReducedMotion", 1);

  const account = MailServices.accounts.createAccount();
  account.incomingServer = MailServices.accounts.createIncomingServer(
    `${account.key}user`,
    "localhost",
    "none"
  );
  account.addIdentity(MailServices.accounts.createIdentity());
  rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  outboxFolder = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Queue);
  trashFolder = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);

  folderA = rootFolder.createLocalSubfolder("folderA");
  folderB = rootFolder.createLocalSubfolder("folderB");
  folderC = rootFolder.createLocalSubfolder("folderC");

  registerCleanupFunction(async () => {
    MailServices.accounts.removeAccount(account, false);
    Services.prefs.clearUserPref("ui.prefersReducedMotion");
  });
});

async function startDrag(element, target) {
  const elementRow = about3Pane.folderPane.getRowForFolder(element);
  const targetRow = about3Pane.folderPane.getRowForFolder(target);
  const targetRect = targetRow.getBoundingClientRect();
  const center =
    targetRect.top + targetRow.clientTop + targetRow.clientHeight / 2;

  dragService.startDragSessionForTests(
    about3Pane,
    Ci.nsIDragService.DRAGDROP_ACTION_MOVE
  );
  [result, dataTransfer] = EventUtils.synthesizeDragOver(
    elementRow,
    targetRow,
    null,
    null,
    about3Pane,
    about3Pane
  );

  EventUtils.sendDragEvent(
    {
      type: "dragover",
      clientY: center,
      dataTransfer,
      _domDispatchOnly: true,
    },
    targetRow,
    about3Pane
  );

  Assert.equal(
    dataTransfer.effectAllowed,
    "copyMove",
    "effectAllowed of drag operation"
  );
  Assert.equal(dataTransfer.dropEffect, "move", "dropEffect of drag operation");
  await new Promise(resolve => setTimeout(resolve));
}

async function endDrag(target) {
  const targetRow = about3Pane.folderPane.getRowForFolder(target);
  const targetRect = targetRow.getBoundingClientRect();
  const center =
    targetRect.top + targetRow.clientTop + targetRow.clientHeight / 2;

  EventUtils.synthesizeDropAfterDragOver(
    result,
    dataTransfer,
    targetRow,
    about3Pane,
    { type: "drop", clientY: center, _domDispatchOnly: true }
  );
  dragService.getCurrentSession().endDragSession(true);
  await new Promise(resolve => setTimeout(resolve));
}

add_task(async function test_drag_and_drop_unselected_folder() {
  Assert.deepEqual(
    Array.from(
      folderTree.querySelectorAll("[role=group] li"),
      folderTreeRow => folderTreeRow.uri
    ),
    [rootFolder, trashFolder, outboxFolder, folderA, folderB, folderC].map(
      folder => folder.URI
    )
  );

  // Click on folderA to select it.
  EventUtils.synthesizeMouseAtCenter(
    about3Pane.folderPane.getRowForFolder(folderA).querySelector(".name"),
    {},
    about3Pane
  );
  Assert.equal(folderTree.selectedIndex, 3);
  EventUtils.synthesizeMouseAtCenter(
    folderPane.getRowForFolder(folderC).querySelector(".name"),
    { accelKey: true },
    about3Pane
  );
  Assert.equal(folderTree.selection.size, 2);

  await startDrag(folderB, folderC);
  Assert.equal(
    dataTransfer.mozItemCount,
    1,
    "Only the unselected folder is dragged"
  );
  Assert.equal(dataTransfer.mozGetDataAt("text/x-moz-folder", 0), folderB);
  await endDrag(folderC);

  // The backend folder move is asynchronous. Wait for it to complete
  // and assign the new folder reference as soon as it succeeds.
  await BrowserTestUtils.waitForCondition(() => {
    try {
      folderB = folderC.getChildNamed("folderB");
      return !!folderB;
    } catch (ex) {
      // getChildNamed throws an XPCOM error if the folder doesn't exist yet.
      return false;
    }
  }, "Wait for folderB to successfully become a child of folderC");

  Assert.deepEqual(
    Array.from(
      folderTree.querySelectorAll("[role=group] li"),
      folderTreeRow => folderTreeRow.uri
    ),
    [rootFolder, trashFolder, outboxFolder, folderA, folderC, folderB].map(
      folder => folder.URI
    )
  );
});

add_task(async function test_drag_and_drop_selected_folder() {
  EventUtils.synthesizeMouseAtCenter(
    folderPane.getRowForFolder(folderB).querySelector(".name"),
    {},
    about3Pane
  );
  Assert.equal(folderTree.selection.size, 1);

  await startDrag(folderB, rootFolder);
  Assert.equal(dataTransfer.mozItemCount, 1);
  Assert.equal(dataTransfer.mozGetDataAt("text/x-moz-folder", 0), folderB);
  await endDrag(rootFolder);

  await BrowserTestUtils.waitForCondition(
    () => rootFolder.containsChildNamed("folderB"),
    "The selected folder moves back to the root"
  );
  Assert.ok(!folderC.containsChildNamed("folderB"));
});

add_task(async function test_drag_and_drop_multiple_folders() {
  const sourceA = rootFolder.createLocalSubfolder("multiA");
  const sourceB = rootFolder.createLocalSubfolder("multiB");
  const target = rootFolder.createLocalSubfolder("multiTarget");
  const child = sourceA
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("child");
  const generator = new MessageGenerator();
  const messageIDs = [sourceA, sourceB, child].map(folder => {
    const message = generator.makeMessage();
    folder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .addMessage(message.toMessageString());
    return [...folder.messages].map(header => header.messageId);
  });

  EventUtils.synthesizeMouseAtCenter(
    folderPane.getRowForFolder(sourceA).querySelector(".name"),
    {},
    about3Pane
  );
  EventUtils.synthesizeMouseAtCenter(
    folderPane.getRowForFolder(sourceB).querySelector(".name"),
    { accelKey: true },
    about3Pane
  );
  Assert.equal(folderTree.selection.size, 2);

  await startDrag(sourceB, target);
  Assert.equal(
    dataTransfer.mozItemCount,
    2,
    "Both selected folders are dragged"
  );
  Assert.deepEqual(
    Array.from(
      { length: dataTransfer.mozItemCount },
      (_, index) =>
        dataTransfer
          .mozGetDataAt("text/x-moz-folder", index)
          .QueryInterface(Ci.nsIMsgFolder).URI
    ),
    [sourceA.URI, sourceB.URI]
  );
  await endDrag(target);

  await BrowserTestUtils.waitForCondition(
    () =>
      target.containsChildNamed("multiA") &&
      target.containsChildNamed("multiB"),
    "Both selected folders arrive in the destination"
  );
  Assert.ok(!rootFolder.containsChildNamed("multiA"), "First source was moved");
  Assert.ok(
    !rootFolder.containsChildNamed("multiB"),
    "Second source was moved"
  );
  const movedA = target.getChildNamed("multiA");
  const movedB = target.getChildNamed("multiB");
  Assert.deepEqual(
    [movedA, movedB, movedA.getChildNamed("child")].map(folder =>
      [...folder.messages].map(header => header.messageId)
    ),
    messageIDs,
    "Messages and nested folders survive both moves"
  );
  await new Promise(resolve => setTimeout(resolve));
  Assert.ok(
    [...folderTree.selection].every(row => row.isConnected),
    "The selection contains no removed folder rows"
  );
});
