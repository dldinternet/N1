import {DOMUtils, ComposerExtension, Spellchecker} from 'nylas-exports';

const recycled = [];

function getSpellingNodeForText(text) {
  let node = recycled.pop();
  if (!node) {
    node = document.createElement('spelling');
    node.classList.add('misspelled');
  }
  node.textContent = text;
  return node;
}

function recycleSpellingNode(node) {
  recycled.push(node);
}

export default class SpellcheckComposerExtension extends ComposerExtension {

  static onContentChanged({editor}) {
    SpellcheckComposerExtension.update(editor);
  }

  static onShowContextMenu = ({editor, menu}) => {
    const selection = editor.currentSelection();
    const range = DOMUtils.Mutating.getRangeAtAndSelectWord(selection, 0);
    const word = range.toString();

    Spellchecker.appendSpellingItemsToMenu({
      menu,
      word,
      onCorrect: (correction) => {
        DOMUtils.Mutating.applyTextInRange(range, selection, correction);
        SpellcheckComposerExtension.update(editor);
      },
      onDidLearn: () => {
        SpellcheckComposerExtension.update(editor);
      },
    });
  }

  static update = (editor) => {
    SpellcheckComposerExtension._unwrapWords(editor);
    Spellchecker.handler.provideHintText(editor.rootNode.textContent)
    // This should technically be in a .then() clause of the promise returned by
    // provideHintText(), but that doesn't work for some reason. provideHintText()
    // currently runs fast enough, or _wrapMisspelledWords() runs slow enough,
    // that just running _wrapMisspelledWords() immediately works as intended.
    SpellcheckComposerExtension._wrapMisspelledWords(editor)
  }

  // Creates a shallow copy of a selection object where anchorNode / focusNode
  // can be changed, and provides it to the callback provided. After the callback
  // runs, it applies the new selection if `snapshot.modified` has been set.

  // Note: This is different from ExposedSelection because the nodes are not cloned.
  // In the callback functions, we need to check whether the anchor/focus nodes
  // are INSIDE the nodes we're adjusting.
  static _whileApplyingSelectionChanges = (cb) => {
    const selection = document.getSelection();
    const selectionSnapshot = {
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset,
      modified: false,
    };

    cb(selectionSnapshot);

    if (selectionSnapshot.modified) {
      selection.setBaseAndExtent(selectionSnapshot.anchorNode, selectionSnapshot.anchorOffset, selectionSnapshot.focusNode, selectionSnapshot.focusOffset);
    }
  }

  // Removes all of the <spelling> nodes found in the provided `editor`.
  // It normalizes the DOM after removing spelling nodes to ensure that words
  // are not split between text nodes. (ie: doesn, 't => doesn't)
  static _unwrapWords = (editor) => {
    SpellcheckComposerExtension._whileApplyingSelectionChanges((selectionSnapshot) => {
      const spellingNodes = editor.rootNode.querySelectorAll('spelling');
      for (let ii = 0; ii < spellingNodes.length; ii++) {
        const node = spellingNodes[ii];
        if (selectionSnapshot.anchorNode === node) {
          selectionSnapshot.anchorNode = node.firstChild;
        }
        if (selectionSnapshot.focusNode === node) {
          selectionSnapshot.focusNode = node.firstChild;
        }
        selectionSnapshot.modified = true;
        while (node.firstChild) {
          node.parentNode.insertBefore(node.firstChild, node);
        }
        recycleSpellingNode(node);
        node.parentNode.removeChild(node);
      }
    });

    editor.rootNode.normalize();
  }


  // Traverses all of the text nodes within the provided `editor`. If it finds a
  // text node with a misspelled word, it splits it, wraps the misspelled word
  // with a <spelling> node and updates the selection to account for the change.
  static _wrapMisspelledWords = (editor) => {
    SpellcheckComposerExtension._whileApplyingSelectionChanges((selectionSnapshot) => {
      const treeWalker = document.createTreeWalker(editor.rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) => {
          // skip the entire subtree inside <code> tags and <a> tags...
          if ((node.nodeType === Node.ELEMENT_NODE) && (["CODE", "A", "PRE"].includes(node.tagName))) {
            return NodeFilter.FILTER_REJECT;
          }
          return (node.nodeType === Node.TEXT_NODE) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });

      const nodeList = [];

      while (treeWalker.nextNode()) {
        nodeList.push(treeWalker.currentNode);
      }

      // Note: As a performance optimization, we stop spellchecking after encountering
      // 30 misspelled words. This keeps the runtime of this method bounded!
      let nodeMisspellingsFound = 0;

      while (true) {
        const node = nodeList.shift();
        if ((node === undefined) || (nodeMisspellingsFound > 15)) {
          break;
        }

        const nodeContent = node.textContent;
        const nodeWordRegexp = /(\w[\w'’-]*\w|\w)/g; // https://regex101.com/r/bG5yC4/1

        while (true) {
          const match = nodeWordRegexp.exec(nodeContent);
          if ((match === null) || (nodeMisspellingsFound > 15)) {
            break;
          }

          if (Spellchecker.isMisspelled(match[0])) {
            // The insertion point is currently at the end of this misspelled word.
            // Do not mark it until the user types a space or leaves.
            if ((selectionSnapshot.focusNode === node) && (selectionSnapshot.focusOffset === match.index + match[0].length)) {
              continue;
            }

            const matchNode = (match.index === 0) ? node : node.splitText(match.index);
            const afterMatchNode = matchNode.splitText(match[0].length);

            const spellingSpan = getSpellingNodeForText(match[0]);
            matchNode.parentNode.replaceChild(spellingSpan, matchNode);

            for (const prop of ['anchor', 'focus']) {
              if (selectionSnapshot[`${prop}Node`] === node) {
                if (selectionSnapshot[`${prop}Offset`] > match.index + match[0].length) {
                  selectionSnapshot[`${prop}Node`] = afterMatchNode;
                  selectionSnapshot[`${prop}Offset`] -= match.index + match[0].length;
                  selectionSnapshot.modified = true;
                } else if (selectionSnapshot[`${prop}Offset`] >= match.index) {
                  selectionSnapshot[`${prop}Node`] = spellingSpan.childNodes[0];
                  selectionSnapshot[`${prop}Offset`] -= match.index;
                  selectionSnapshot.modified = true;
                }
              }
            }

            nodeMisspellingsFound += 1;
            nodeList.unshift(afterMatchNode);
            break;
          }
        }
      }
    });
  }

  static applyTransformsForSending = ({draftBodyRootNode}) => {
    const spellingEls = draftBodyRootNode.querySelectorAll('spelling');
    for (const spellingEl of Array.from(spellingEls)) {
      // move contents out of the spelling node, remove the node
      const parent = spellingEl.parentNode;
      while (spellingEl.firstChild) {
        parent.insertBefore(spellingEl.firstChild, spellingEl);
      }
      parent.removeChild(spellingEl);
    }
  }

  static unapplyTransformsForSending = () => {
    // no need to put spelling nodes back!
  }
}
