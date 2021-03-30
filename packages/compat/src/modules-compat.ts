import { Funnel } from 'broccoli-funnel';
import { Node } from 'broccoli-node-api';
import mergeTrees from 'broccoli-merge-trees';

// there is a weirder, older behavior where addons wrapped their addon tree
// output in a `modules` folder. This strips that level off if it exists,
// without discarding any other content that was not inside `modules`.

export default function modulesCompat(tree: Node) {
  return mergeTrees([
    new Funnel(tree, { exclude: ['modules'] }),
    new Funnel(tree, { srcDir: 'modules', allowEmpty: true }),
  ]);
}
