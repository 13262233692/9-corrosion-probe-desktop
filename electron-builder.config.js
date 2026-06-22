module.exports = {
  appId: 'com.example.corrosion-probe',
  productName: '腐蚀探针数据采集系统',
  directories: {
    output: 'release'
  },
  files: [
    'dist/**/*',
    'electron/**/*',
    'package.json'
  ],
  asar: true,
  mac: {
    target: ['dmg'],
    icon: 'build/icon.png'
  },
  win: {
    target: ['nsis'],
    icon: 'build/icon.png'
  },
  linux: {
    target: ['AppImage'],
    icon: 'build/icon.png'
  }
};
