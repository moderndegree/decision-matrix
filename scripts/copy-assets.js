const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const copies = [
  [
    'nodes/DecisionMatrix/decisionMatrix.svg',
    'dist/nodes/DecisionMatrix/decisionMatrix.svg',
  ],
  [
    'nodes/DecisionMatrix/decisionMatrix.dark.svg',
    'dist/nodes/DecisionMatrix/decisionMatrix.dark.svg',
  ],
  [
    'nodes/DecisionMatrix/DecisionMatrix.node.json',
    'dist/nodes/DecisionMatrix/DecisionMatrix.node.json',
  ],
];

for (const [from, to] of copies) {
  const source = path.join(root, from);
  const target = path.join(root, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
