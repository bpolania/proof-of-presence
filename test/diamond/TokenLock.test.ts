import {expect} from '../chai-setup';
import {deployments, getUnnamedAccounts, ethers, network} from 'hardhat';
import {TDFToken, TDFDiamond} from '../../typechain';
import {setupUser, setupUsers} from '../utils';
import {Contract} from 'ethers';
import {parseEther} from 'ethers/lib/utils';
import {addDays, getUnixTime} from 'date-fns';
import {diamondTest} from '../utils/diamond';
const BN = ethers.BigNumber;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getMock(name: string, deployer: string, args: Array<any>): Promise<Contract> {
  await deployments.deploy(name, {from: deployer, args: args});
  return ethers.getContract(name, deployer);
}

const setup = deployments.createFixture(async (hre) => {
  const {deployments, getNamedAccounts, ethers} = hre;
  await deployments.fixture();

  const accounts = await getNamedAccounts();
  const users = await getUnnamedAccounts();
  const {deployer, TDFTokenBeneficiary} = accounts;

  const token: TDFToken = await ethers.getContract('TDFToken', deployer);
  const contracts = {
    TDFToken: token,
    TDFDiamond: <TDFDiamond>await ethers.getContract('TDFDiamond', deployer),
  };

  const tokenBeneficiary = await setupUser(TDFTokenBeneficiary, contracts);

  const conf = {
    ...contracts,
    users: await setupUsers(users, contracts),
    deployer: await setupUser(deployer, contracts),
    TDFTokenBeneficiary: tokenBeneficiary,
    accounts,
  };
  // fund users with TDF token
  await Promise.all(
    users.map((e) => {
      return conf.TDFTokenBeneficiary.TDFToken.transfer(e, parseEther('10000'));
    })
  );
  return conf;
});

const incDays = async (days: number) => {
  // suppose the current block has a timestamp of 01:00 PM
  await network.provider.send('evm_increaseTime', [days * 86400]);
  await network.provider.send('evm_mine');
};

const buildDates = (initDate: Date, amount: number) => {
  const acc = [];
  for (let i = 0; i < amount; i++) {
    acc.push(getUnixTime(addDays(initDate, i)));
  }
  return acc;
};
const buildDate = (offset: number) => {
  const initDate = Date.now();
  return getUnixTime(addDays(initDate, offset));
};

const timeTravelTo = async (time: number) => {
  await network.provider.send('evm_setNextBlockTimestamp', [time]);
  await network.provider.send('evm_mine');
};

describe('TokenLockFacet', () => {
  it('lock and unlockMax', async () => {
    const {users, TDFDiamond, TDFToken, deployer} = await setup();

    const user = users[0];
    const {test, TLF} = await diamondTest({
      diamond: TDFDiamond,
      tokenContract: TDFToken,
      user: user,
      admin: deployer,
    });
    const {deposit, withdrawMax} = TLF;

    expect(await TDFToken.balanceOf(user.address)).to.eq(parseEther('10000'));
    await test.balances('0', '0', '10000');

    await user.TDFToken.approve(TDFDiamond.address, parseEther('10'));
    await deposit('1');

    await test.balances('1', '1', '9999');

    await withdrawMax.none();
    await test.balances('1', '1', '9999');

    await incDays(1);
    await deposit('1');
    await test.balances('2', '2', '9998');
    await withdrawMax.success('1');
    await test.balances('1', '1', '9999');

    await incDays(1);
    await withdrawMax.success('1');
    await test.balances('0', '0', '10000');

    await expect(user.TDFDiamond.withdrawMax()).to.be.revertedWith('NOT_ENOUGHT_BALANCE');
  });
  it('lock and unlock', async () => {
    const {users, TDFDiamond, TDFToken, deployer} = await setup();

    const user = users[0];
    const {test, TLF} = await diamondTest({
      diamond: TDFDiamond,
      tokenContract: TDFToken,
      user: user,
      admin: deployer,
    });
    const {deposit, withdrawMax, withdraw} = TLF;

    expect(await TDFToken.balanceOf(user.address)).to.eq(parseEther('10000'));
    await test.balances('0', '0', '10000');

    await user.TDFToken.approve(user.TDFDiamond.address, parseEther('10'));

    ///////////////////////////////////////////////
    //                DAY 0
    // ------------------------------------------
    // Before: NOTHING
    // During:
    //     - lock 1 token
    // After:
    //     - 1 token unlockable
    ///////////////////////////////////////////////
    await deposit('1');
    await test.balances('1', '1', '9999');
    await withdraw.reverted('0.5');
    // Does not change the balances, nothing to unlock
    await test.balances('1', '1', '9999');

    ///////////////////////////////////////////////
    //  DAY 1
    ///////////////////////////////////////////////
    await incDays(1);
    await deposit('1');

    await test.balances('2', '2', '9998');

    expect(await TDFDiamond.unlockedAmount(user.address)).to.eq(parseEther('1'));
    // we only have available 1
    // we are not able to redeem more than 1
    // So trying to remove more will be reverted
    await withdraw.reverted('1.5');
    // With the balances unchaded
    await test.balances('2', '2', '9998');
    // remove in lower bound of pocket
    await withdraw.success('0.5');
    await test.balances('1.5', '1.5', '9998.5');

    ///////////////////////////////////////////////
    //  DAY 2
    // --------------------------------------------
    // Now we have two buckets
    // 1) with 0.5
    // 2) with 1
    // remove in the upper bound
    // 0.5 + 0.75 = 1.25
    // reminder of 0.25
    ///////////////////////////////////////////////
    await incDays(1);
    await withdraw.success('1.25');

    await test.balances('0.25', '0.25', '9999.75');
    // Add more balance to stress test
    await deposit('1.5');

    await test.balances('1.75', '1.75', '9998.25');
    await withdrawMax.success('0.25');
    await test.balances('1.5', '1.5', '9998.50');
    await incDays(1);
    ///////////////////////////////////////////////
    //  DAY 3
    // Unlock all
    ///////////////////////////////////////////////
    await withdraw.success('1.3');

    await test.balances('0.2', '0.2', '9999.8');
    await withdrawMax.success('0.2');
    await test.balances('0', '0', '10000');
  });

  it('restakeMax', async () => {
    const {users, TDFDiamond, TDFToken, deployer} = await setup();
    const user = users[0];

    const {test, TLF} = await diamondTest({
      diamond: TDFDiamond,
      tokenContract: TDFToken,
      user: user,
      admin: deployer,
    });
    const {deposit, withdrawMax, restakeMax} = TLF;

    expect(await TDFToken.balanceOf(user.address)).to.eq(parseEther('10000'));
    await test.balances('0', '0', '10000');

    await user.TDFToken.approve(user.TDFDiamond.address, parseEther('10'));
    await deposit('1');

    await test.balances('1', '1', '9999');
    await test.stake('1', '0');
    await incDays(1);
    await deposit('0.5');
    await test.balances('1.5', '1.5', '9998.5');
    await test.stake('0.5', '1');
    await restakeMax();
    await test.balances('1.5', '1.5', '9998.5');
    await test.stake('1.5', '0');
    await incDays(1);
    await withdrawMax.success('1.5');
    await test.balances('0', '0', '10000');
    await test.stake('0', '0');
  });
  it('restake(uint256 amount)', async () => {
    const {users, TDFDiamond, TDFToken, deployer} = await setup();
    const user = users[0];
    const {test, TLF} = await diamondTest({
      diamond: TDFDiamond,
      tokenContract: TDFToken,
      user: user,
      admin: deployer,
    });
    const {deposit, withdrawMax, restakeMax, restake, withdraw} = TLF;

    expect(await TDFToken.balanceOf(user.address)).to.eq(parseEther('10000'));
    await test.balances('0', '0', '10000');

    await user.TDFToken.approve(user.TDFDiamond.address, parseEther('10'));
    ///////////////////////////////////////////////
    //                DAY 0
    ///////////////////////////////////////////////
    await deposit('1');

    await test.balances('1', '1', '9999');
    await test.stake('1', '0');
    // Restake max without any untied amount
    await restakeMax();
    // Results in nothing changes
    await test.balances('1', '1', '9999');
    await test.stake('1', '0');

    await incDays(1);
    ///////////////////////////////////////////////
    //                DAY 1
    ///////////////////////////////////////////////
    await deposit('0.5');

    await test.balances('1.5', '1.5', '9998.5');
    await test.stake('0.5', '1');
    // Trying to restake more than unlocked will revert
    await restake.reverted('1.5');
    await test.balances('1.5', '1.5', '9998.5');
    await test.stake('0.5', '1');
    await incDays(1);
    ///////////////////////////////////////////////
    //                DAY 2
    ///////////////////////////////////////////////
    await test.balances('1.5', '1.5', '9998.5');
    await test.stake('0', '1.5');

    await restake.success('0.5');
    await test.balances('1.5', '1.5', '9998.5');
    await test.stake('0.5', '1');
    await withdraw.success('0.25');
    // await user.TDFDiamond.withdraw(parseEther('0.25'));
    await test.balances('1.25', '1.25', '9998.75');
    await test.stake('0.5', '0.75');
    await withdrawMax.success('0.75');
    await test.balances('0.5', '0.5', '9999.5');
    await test.stake('0.5', '0');
    ///////////////////////////////////////////////
    //                DAY 3
    ///////////////////////////////////////////////
    await incDays(1);
    await withdrawMax.success('0.5');
    await test.balances('0', '0', '10000');
    await test.stake('0', '0');
  });

  it('restakeOrDepositAt', async () => {
    const {users, TDFDiamond, TDFToken, deployer} = await setup();
    const user = users[0];
    const {test, TLF} = await diamondTest({
      diamond: TDFDiamond,
      tokenContract: TDFToken,
      user: user,
      admin: deployer,
    });
    const {withdrawMax, withdraw, restakeOrDepositAtFor} = TLF;

    expect(await TDFToken.balanceOf(user.address)).to.eq(parseEther('10000'));
    await test.balances('0', '0', '10000');

    // await user.TDFToken.approve(deployer.address, parseEther('10'));
    await user.TDFToken.approve(TDFDiamond.address, parseEther('10'));

    let initLockAt = buildDate(3);

    ///////////////////////////////////////////////
    //                DAY 0
    // --------------------------------------------
    // With 0 stake, restake transfers Token to contract
    ///////////////////////////////////////////////
    await restakeOrDepositAtFor('1', initLockAt);
    await test.balances('1', '1', '9999');

    await test.deposits([['1', initLockAt]]);
    await test.stake('1', '0');

    ///////////////////////////////////////////////
    //                DAY 1
    // --------------------------------------------
    // Can not unstake since we staked in the future
    ///////////////////////////////////////////////
    await incDays(1);
    await withdraw.reverted('0.5');
    await test.balances('1', '1', '9999');
    await test.deposits([['1', initLockAt]]);
    await test.stake('1', '0');
    ///////////////////////////////////////////////
    //                DAY 4
    // --------------------------------------------
    // Can withdraw 1
    //
    ///////////////////////////////////////////////
    await incDays(4);

    await withdraw.success('0.5');
    await test.balances('0.5', '0.5', '9999.5');
    await test.deposits([['0.5', initLockAt]]);
    await test.stake('0', '0.5');

    // ------ Can reStake to the future current staked

    initLockAt = buildDate(6);
    await restakeOrDepositAtFor('0.5', initLockAt);

    await test.balances('0.5', '0.5', '9999.5');
    await test.deposits([['0.5', initLockAt]]);
    await test.stake('0.5', '0');
    // can not unstake
    await withdrawMax.none();
    await test.balances('0.5', '0.5', '9999.5');
    await test.deposits([['0.5', initLockAt]]);
    await test.stake('0.5', '0');
    ///////////////////////////////////////////////
    //                DAY 4 - CONT Restake locked
    // --------------------------------------------
    // mixed restake (token transfer, restake)
    // locked 0.5
    ///////////////////////////////////////////////
    initLockAt = buildDate(8);
    await restakeOrDepositAtFor('1', initLockAt);
    await test.balances('1', '1', '9999');
    await test.stake('1', '0');
    await test.deposits([
      ['0.5', initLockAt],
      ['0.5', initLockAt],
    ]);
  });

  it('getters', async () => {});

  it('ownable', async () => {});

  it('pausable', async () => {});
});
