import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { isOpName } from '../host-protocol-ops'
import { OP_CATALOG } from './index'
import type { OpArgs, OpContext } from './types'

// name, tier (self/other/credential file), scope (self/other/lane selector), applies,
// ready flag, surface-only, routability, job, SHA-256 of the closed JSON args schema.
const baseline = `
help read self now - - - - a733adb0de8fac7638ab92d78fb69084762bd3313239e29284d5872d610de0c4
whoami read self now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
policy.show read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
policy.set never machine now - surface local - e958c6bedacb9e2519f6491931643e9e4bd9cc5d402918b1bc1e53c3ea443d66
audit.list read machine now - - - - 14cdab4f33a0819fd2615186e21cb73f718940155b4a471e2cd965f6e3fe933c
audit.undo never machine now - surface local - 8327ffa7f5b8d2809c002729e2063b203e9b420ab7e8fe96b4f1f24fde749f41
confirm.info read machine now - surface local - 4ce565297bf3e668d0b55b0295a6c19c417ebd6609fd32f7cc07944cbf7932b2
confirm.list read machine now - surface local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
confirm.status read machine now - - - - 17bd9cb2a6b18bb1290643396d0d118260dc07f41bb8455880163a89716bc5e7
confirm.approve never machine now - surface local - 17bd9cb2a6b18bb1290643396d0d118260dc07f41bb8455880163a89716bc5e7
confirm.deny never machine now - surface local - 17bd9cb2a6b18bb1290643396d0d118260dc07f41bb8455880163a89716bc5e7
job.status read machine now - - - - 1634ceaab91ed7e7eda4c31f30c5b63ecdf5ef814e15adc64c0a6c92423d7ff6
job.list read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
swarm.on lane self next-request - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
swarm.off lane self next-request - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
model.set lane self after-run - - local - bef0438277ad4a9825b93ff53171acc1c4624d4877464934e31923b39cd00c92
thinking.set lane self after-run - - local - 6a7d79e1e4d55f0973a1ac605243c1c9f8abad1b15969c978b8d31675c040c8a
lane.rename lane self/other-lane now - - - - 7f0fe773ebff90f282291e02ea8cf0952a59d6c315a7e8727d6f9435cbb31ef1
lane.pin lane self/other-lane now - - - - ebd43917f7c5036f11767cefc7198655852010903b8cdc018456aea3ea5507d9
lane.marker lane self/other-lane now - - - - f9b61ca0e4568606e5bfb945dc97be106a5dde9dd84f8b8e0bf7a517cdba3fe7
pr.track lane self now - - local - 2579f6ecb63bc84cdca35ec0c3fa667ce68abec42b4042b47db4928003ceec3f
pr.hide lane self now - - local - 2579f6ecb63bc84cdca35ec0c3fa667ce68abec42b4042b47db4928003ceec3f
pr.clear lane self now - - local - 2579f6ecb63bc84cdca35ec0c3fa667ce68abec42b4042b47db4928003ceec3f
contextFiles.set lane self next-request laneContext - local - e6b438ca7b4da93b08efa745b6d2c1eefffe7df3d1092f1d08fb1070ebb00842
lane.compact lane self after-run - - local - c0a276dc3917cae839ee44430cecad98d4a57e608138f6f81b73cdbd29b21e04
lane.autoCompaction lane self after-run - - local - 747277e2e03bcd747b9bb8f7d09989bdf7755c2751b18d2260707db4a51e9e04
lane.autoRetry lane self after-run - - local - 747277e2e03bcd747b9bb8f7d09989bdf7755c2751b18d2260707db4a51e9e04
lane.queueMode lane self after-run - - local - 3af915363b23553ae96974c4f1a959542bbd62519fea03ac477a4bed932fceaf
lane.reload lane self reload laneReload - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
notify lane self now - - local - 3af0e74ed7b972a0784ddbf3ef32ed963f2ef621be162f5c9483e37d71679c64
mcp.lane lane self now laneContext - local - 90153caa9ce5c1465c7513e8902e509a786551336b0bdb2c4c759c6669cb2634
account.move configure self reload - - local - 439252a416678fb7efbad406ecb6831f5d3803752351cb651c4f0b8117032ca9
lane.list read machine now pagedLanes - - - 8552951b8539e4f24a2918ff9a313f1f05af691598df7dd2a288b00db716fba1
lane.search read machine now - - - - d77496d582b31579076f80c7083a68682949b8b0c9bf8a793ea0a7c21414b559
lane.read read other-lane now - - - - 4e7fb22d4ccaa7714c2447799426fe0216f11cfa2c6631afe5672b5ecd80b124
lane.tree read other-lane now laneEditing - - - 2aa141ab0bf0157a77c20c3c3f09b705ce803466c70bb95fda0dd9f892e8f782
lane.create create machine now - - - - bfeebe97d24db1059630490a2bc595cfd360087f6bf81fa4752b16aed99ba8b6
lane.fork create other-lane now laneEditing - - - 7c2f44408cd428f1a60055543e7bef243534c9e626843bc8f0a29eb322e04973
lane.clone create other-lane now laneEditing - - - 7c2f44408cd428f1a60055543e7bef243534c9e626843bc8f0a29eb322e04973
lane.resume create other-lane now - - - - 2aa141ab0bf0157a77c20c3c3f09b705ce803466c70bb95fda0dd9f892e8f782
lane.stop lane/destructive self/other-lane after-run - - - - 2aa141ab0bf0157a77c20c3c3f09b705ce803466c70bb95fda0dd9f892e8f782
lane.archive lane/destructive self/other-lane after-run - - - - 2aa141ab0bf0157a77c20c3c3f09b705ce803466c70bb95fda0dd9f892e8f782
lane.delete destructive self/other-lane now - - - - e7db0395bc41837dd026ebe6a91a8ca57d87e1b7301b9958a7d6506e9024d559
lane.label lane self/other-lane now laneEditing - - - 81db629d93dd97068d7b62c4afcc6aa336ef9dd16c7365eecad576c39bd1f4b7
lane.jump lane/destructive self/other-lane now laneEditing - - - 6fc13dca070738ce0e588e1d3eda406bf4eac25ea668f5f1d68923118f854acd
lane.rewind lane/destructive self/other-lane now laneEditing - - - 6fc13dca070738ce0e588e1d3eda406bf4eac25ea668f5f1d68923118f854acd
lane.move create other-lane now - - - - fafc1100ab27e88129d8abe18f18f906ea24199fef914f8471d25a40f74523de
lane.export read other-lane now - - - - 2aa141ab0bf0157a77c20c3c3f09b705ce803466c70bb95fda0dd9f892e8f782
lane.markRead lane other-lane now - - - - 2aa141ab0bf0157a77c20c3c3f09b705ce803466c70bb95fda0dd9f892e8f782
archive.list read machine now - - - - 744f747dc65e83bd8d93a8ff0feebf8eb4a50198c8ae70c20e626dfc7ce3f671
archive.restore create machine now - - - - 0a84dfa50cf2c48d9ce01fd3f2f7748a5eb0105a528af804826b3c62d5048050
archive.purge destructive machine now - - - job e8072824784297e0c0745945058537b01eac24b946b16b36ce2b7e59c9ca7c65
artifact.list read machine/other-lane now - - - - 2ebdaaff4cb36e5c8f2305462497c0ed7297b417968e960550a8f457aa222a95
artifact.read read machine/other-lane now - - - - fc11259bef08d96301f6712ec069cf4639f92f156c82b907e529673c66da01b7
artifact.remove destructive machine/other-lane now - - - - fcabaa179a7bc4bad6441da3da78b18e9fa650a43fca2588f2e0a93599f5c4d2
files.list read self/other-lane now - - - - 53638fd33de8cdd6c08d40857d0acc1a9225a086537faf16d404215c15d8ac81
files.read read self/other-lane now - - - - 53638fd33de8cdd6c08d40857d0acc1a9225a086537faf16d404215c15d8ac81
files.search read self/other-lane now - - - - f5da4685520cde3a4f280daa8c2d7ae7e8b5d9fa21ebd7a9ec68fb41d65b8229
files.write lane self/other-lane now - - - - 0f4a8a5448ce21729b39a015bdb415a675663f9941e82983bc62d75b32a0439e
files.create lane self/other-lane now - - - - 8c70bde7249a3546274f2848008b66344271d367b045776c4edaa1289ecc7135
files.mkdir lane self/other-lane now - - - - 53638fd33de8cdd6c08d40857d0acc1a9225a086537faf16d404215c15d8ac81
files.trash lane self/other-lane now - - - - 53638fd33de8cdd6c08d40857d0acc1a9225a086537faf16d404215c15d8ac81
files.rename lane self/other-lane now - - - - 8829732870262b2daa49cad663d0427b8bfa633204c2b7e882b082aa60c82f1e
files.transfer lane self/other-lane now - - - - 79860ed39ad3f9e20f679b863159bcdf914b17ea3f4a8423c35cffa837cce907
git.info read self/other-lane now - - - - d6a5be87c0479f944540c3f2cf4657e204e0bd6ac775270c90f11257ae6cc29a
git.status read self/other-lane now - - - - d6a5be87c0479f944540c3f2cf4657e204e0bd6ac775270c90f11257ae6cc29a
git.diff read self/other-lane now - - - - 8996cd39cea295505823de71ea86b92ba22cf9a30d63f51928345c884d925d07
git.show read self/other-lane now - - - - 40e2ccce7f69d115aeb4c62d834977ab9d1f8796177b7b503b54b58a053de2ac
git.branches read self/other-lane now - - - - d6a5be87c0479f944540c3f2cf4657e204e0bd6ac775270c90f11257ae6cc29a
git.worktrees read self/other-lane now - - - - d6a5be87c0479f944540c3f2cf4657e204e0bd6ac775270c90f11257ae6cc29a
git.fetch lane self/other-lane now - - - - 3f11ddd1108d977c50e29f55ffdb1aca3659e6d7d4460e42d4341abb86ce45a4
git.pull lane self/other-lane now - - - - d6a5be87c0479f944540c3f2cf4657e204e0bd6ac775270c90f11257ae6cc29a
git.updateFromMain lane self/other-lane now - - - - 4f77757e2644ad4d1de23a16eae9d8f412dc0055f09f6013e87e5ae12d5325f4
git.commitAll lane self/other-lane now - - - - 3018e97ef8523c134b76525fd515da9cec514ec0c524b4ea77faeead62c6cfcf
git.checkout lane self/other-lane now - - - - 10903c93f0cfb22cf9898c9b7195ffe62c80176ad4a0aee9384c6f4ab52f3384
git.renameBranch lane self/other-lane now - - - - 9d5f3e0177e0856f486918995c139079ad8da576133786170ebed1a3440e4b5e
git.restoreFile lane self/other-lane now - - - - 40e2ccce7f69d115aeb4c62d834977ab9d1f8796177b7b503b54b58a053de2ac
git.merge configure self/other-lane now - - - - 10903c93f0cfb22cf9898c9b7195ffe62c80176ad4a0aee9384c6f4ab52f3384
worktree.add create machine now - - - - 74b3ae00bcad0908815ab12fd77d1a1a36af3d644379a337f485a5088d7934a8
worktree.restore create machine now - - - - 74b3ae00bcad0908815ab12fd77d1a1a36af3d644379a337f485a5088d7934a8
worktree.recreate create machine now - - - - 74b3ae00bcad0908815ab12fd77d1a1a36af3d644379a337f485a5088d7934a8
worktree.remove destructive machine now - - - - 7884bf33fac783d9c58649487c69436f34268986237ccc29299a05aaa9259945
worktree.prune destructive machine now - - - - 27df0035ed29980f4a14e99c65409125f30d9c5a73acf34a68458e96ee97bbb9
pr.list read self/other-lane now - - - - d6a5be87c0479f944540c3f2cf4657e204e0bd6ac775270c90f11257ae6cc29a
pr.status read self/other-lane now - - - - 25ede3320c42ac78e55c1c78df99ad4025701b3c3f89d13642eee982f73ada74
pr.detail read self/other-lane now - - - - 67897f59d09b28dfb4b9aebf63a611c1214aae84c4830cd3b7a0a80f9860528f
folder.list read machine now pagedLanes - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
folder.browse read machine now - - - - f378100f83c0b99615cb20119f5547cd1058c5bf3e3ba3ef09e0fed1e4e950ef
folder.add create machine now - - - - 27df0035ed29980f4a14e99c65409125f30d9c5a73acf34a68458e96ee97bbb9
folder.create create machine now - - - - 27df0035ed29980f4a14e99c65409125f30d9c5a73acf34a68458e96ee97bbb9
folder.order create machine now - - - - 8d1ef8acd4670b7556748173a0f322af414e0abca13f1736a0026fc2b58a9be5
folder.remove destructive machine now - - - - 0a84dfa50cf2c48d9ce01fd3f2f7748a5eb0105a528af804826b3c62d5048050
sandbox.list read machine now sandboxes - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
sandbox.create create machine now sandboxes - - - 44d002cc5c2e53919d36f5ee14b7dd5db5770a5f38af14ea41679838e72cbc1d
sandbox.rename persistence machine now sandboxes - - - 87a3d75aa8d4d1e2efa3a40d2c83cb63541787f2091875189b98ab6341e15ae3
sandbox.delete destructive machine now sandboxes - - - 27df0035ed29980f4a14e99c65409125f30d9c5a73acf34a68458e96ee97bbb9
routine.list read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
routine.history read machine now - - - - ac2273c53a48d45f4e63a9d91a879e9c07646daaef58667d342acf67891f0d7f
routine.activity read machine now - - - - b67317bb3a20672a858a98a5d7d430ce15fcd9a876f444965fdce55346bba3fc
routine.check read machine now - - - - 9eabc16ad534d12588a51aa6a56376459b79bc86ccf6d581bc72b6797047877c
routine.create persistence machine now - - - - 9eabc16ad534d12588a51aa6a56376459b79bc86ccf6d581bc72b6797047877c
routine.fromLane persistence machine now - - - - ee1a6bbf6c49044232048269a0db760d549e06168f64d1bb8f7fdaf4bd10c292
routine.edit persistence machine now - - - - 0c0985f809dcaba45411d4830a385d5f7423374c6d35203f7fe7c37de1950836
routine.enable persistence machine now - - - - 0a84dfa50cf2c48d9ce01fd3f2f7748a5eb0105a528af804826b3c62d5048050
routine.disable persistence machine now - - - - 0a84dfa50cf2c48d9ce01fd3f2f7748a5eb0105a528af804826b3c62d5048050
routine.run create machine now - - - - 0a84dfa50cf2c48d9ce01fd3f2f7748a5eb0105a528af804826b3c62d5048050
routine.cancel create machine now - - - - ee1a6bbf6c49044232048269a0db760d549e06168f64d1bb8f7fdaf4bd10c292
routine.skipNext persistence machine now - - - - 0a84dfa50cf2c48d9ce01fd3f2f7748a5eb0105a528af804826b3c62d5048050
routine.pauseAll persistence machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
routine.archive persistence machine now - - - - 0a84dfa50cf2c48d9ce01fd3f2f7748a5eb0105a528af804826b3c62d5048050
routine.delete destructive machine now - - - - 0a84dfa50cf2c48d9ce01fd3f2f7748a5eb0105a528af804826b3c62d5048050
skill.list read machine now - - - - c57e5987bdbbc8d6bf059cc32f8702b76da3f75ff2e38e6a4d7e9bfebb8d2f48
skill.read read machine now - - - - d6e3d4e2ea7895d0975913aa85b3ea0e983abb75ff9582b307329093806b4fbd
skill.create persistence machine reload configFiles - - - a01f8d27a823b3e1384d8cb8a661fc9d051584c6e5e42785f5213b139c4e67fb
skill.edit persistence machine reload configFiles - - - e4238a93b1545f6802f08e1d81b5c02e1f75d30deff4970d71722c7b8ba23712
skill.install persistence machine reload - - - - 9acb008671e67fe4c5b44fe4f0eef9bbaddf0b25131ab3328716138e27334f93
skill.share persistence machine reload - - - - 9054935b2fc58b9673fe54c2056ee8fdaaf874bbb8809a95b7dbd50f33dc29d1
skill.delete destructive machine now configFiles - - - f16f2498673e932012df57539890a0ec21f855c5f74bf0135bc86e43dc7aed3c
mcp.list read machine now - - - - c57e5987bdbbc8d6bf059cc32f8702b76da3f75ff2e38e6a4d7e9bfebb8d2f48
mcp.check read machine now - - - - d59da275452fdfe196154d19c54a42076e994c4d4a59ab6a89ed2083408e7fac
mcp.add persistence machine reload - - - - efe9ad47ce87434a4f7268262380f9c690610aaf6b01f7aea3ba8306dbd92d30
mcp.update persistence machine reload - - - - efe9ad47ce87434a4f7268262380f9c690610aaf6b01f7aea3ba8306dbd92d30
mcp.enable persistence machine reload - - - - af625573641fa2ccdce40c019f4abd038812a87bd0a2291afe1c4118b10186ff
mcp.disable persistence machine reload - - - - af625573641fa2ccdce40c019f4abd038812a87bd0a2291afe1c4118b10186ff
mcp.expose persistence machine reload - - - - a36358f1137d419a45a601383cf6811144b952527a081b8f9551dde93bf1d040
mcp.remove destructive machine now - - - - af625573641fa2ccdce40c019f4abd038812a87bd0a2291afe1c4118b10186ff
package.list read machine now - - - - c57e5987bdbbc8d6bf059cc32f8702b76da3f75ff2e38e6a4d7e9bfebb8d2f48
package.checkUpdates read machine now - - - - c57e5987bdbbc8d6bf059cc32f8702b76da3f75ff2e38e6a4d7e9bfebb8d2f48
package.install persistence machine reload - - - job 23db941b508ceb0cc228bc3da365b154017b919aeb81a71f93f95f7b03205939
package.update persistence machine reload - - - job cca66be15460fc257f4c9b693fdbc5970c3d90cd73d8629844bb42419d504007
package.remove persistence machine reload - - - job 23db941b508ceb0cc228bc3da365b154017b919aeb81a71f93f95f7b03205939
claude.installProvider persistence machine reload - - - job 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
claude.installCli persistence machine reload - - - job 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
settings.read read machine now - - - - b583a3ed7b8127be3f8295c5b0c5ee0001bfefa7f705cb826e6ab7f6a3eeae8d
settings.set configure machine new-lanes - - - - 485f4a960173a17dc2cefacaab8c8407bb7d144771b0caa06fd3519a079f1683
directives.set configure machine next-request folderDirectives - - - ab0b3b1be28a352335934d88720fa83661a4245e23213864fbd7fb9908d5b42c
instructions.read read machine now - - - - c226287455067d173a9742fe4d3f4cc53ff0e7512ed7df9276c655a3630912b6
instructions.edit persistence machine next-request - - - - b71c4121501aef1177284d95ca2742b3f1d30f8bba3692c2d34ab793a76dce48
config.read read/never machine now configFiles - - - 998b4a286805425b70e925d4ee9f505399c3d0e39fd42052a634e0972da84fe7
config.write persistence/never machine reload configFiles - - - e8983f45684ec98434e0e3b002353a7589daec3ec975abe448e8536522bfed39
claude.accounts read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
claude.routing configure machine new-lanes - - - - edd52ffb3c32267944a7157a2956b245adb2b61df01b1653eaee0e234ec01139
claude.reorder configure machine new-lanes - - - - d41d6ee7ba1c9a3889a121b976831960390a0bd8efffa6b1cb3fdda62636b7ab
machine.status read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
machine.doctor read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
machine.models read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
machine.providers read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
machine.commands read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
machine.usage read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
service.update destructive machine now - - - job 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
maintenance.scan read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
maintenance.run destructive machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
hosts.list read machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
brain.search read self now - - local - 07a2a5546a3c9fbad64c315db0789c97cf7d0498721cc19f0cf3c1cc8c9c30e4
brain.flag lane self now - - local - 5b85d6a81378bcd3832d874a33ff22ecc970492f17ede6109ec083a89881b556
brain.status read machine now - - - - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
brain.find read machine now - - - - 07a2a5546a3c9fbad64c315db0789c97cf7d0498721cc19f0cf3c1cc8c9c30e4
brain.queue lane machine now - - - - 96b2ad3044f9bf47d16805c4036fb226092e66fa88a8bb0c53cbaaa164c40d00
ui.open lane self now - - local - d6a5be87c0479f944540c3f2cf4657e204e0bd6ac775270c90f11257ae6cc29a
account.signIn never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
account.signOut never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
provider.login never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
provider.logout never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
claude.login never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
claude.logout never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
claude.addAccount never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
claude.removeAccount never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
mcp.login never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
mcp.logout never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
machine.enroll never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
control.machines never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
control.lookupEnrollment never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
control.approveEnrollment never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
control.renameMachine never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
control.removeMachine never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
grant.issue never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
hosts.settingsAccess never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
agentControl.set never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
routine.trust never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
routine.allowOps never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
folder.trust never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
webAccess.key never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
brain.review never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
brain.tidy never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
brain.merge never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
brain.forget never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
brain.reset never machine now - - local - 32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e
`
  .trim()
  .split('\n')

function variants<T extends string>(field: T | ((a: OpArgs, c: OpContext) => T)) {
  if (typeof field !== 'function') return field
  return [
    ...new Set([
      field({ file: 'settings' }, { self: true }),
      field({ file: 'settings', lane: 'other' }, { self: false }),
      field({ file: 'models' }, { self: false }),
    ]),
  ].join('/')
}
it('freezes the catalog declarations and argument schemas', () => {
  const rows = OP_CATALOG.map((op) =>
    [
      op.name,
      variants(op.tier),
      variants(op.scope),
      op.applies,
      op.flag ?? '-',
      op.surfaceOnly ? 'surface' : '-',
      op.routable === false ? 'local' : '-',
      op.job ? 'job' : '-',
      createHash('sha256').update(JSON.stringify(op.args)).digest('hex'),
    ].join(' '),
  )
  expect(rows).toEqual(baseline)
})
it('names each op once; help, positionals and redactions describe the actual arguments', () => {
  expect(new Set(OP_CATALOG.map((op) => op.name)).size).toBe(OP_CATALOG.length)
  for (const op of OP_CATALOG) {
    expect(isOpName(op.name), op.name).toBe(true)
    expect(op.summary, op.name).toMatch(/^[^\n]+$/)
    expect(op.args.additionalProperties, op.name).toBe(false)
    for (const key of [...(op.positional ?? []), ...(op.sensitive ?? [])])
      expect(Object.hasOwn(op.args.properties, key), `${op.name}.${key}`).toBe(true)
  }
})
