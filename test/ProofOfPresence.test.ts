import {expect} from './chai-setup';
import {deployments, getUnnamedAccounts, ethers, network} from 'hardhat';
import {TDFToken, ProofOfPresence, TokenLock} from '../typechain';
import {setupUser, setupUsers} from './utils';
import {Contract} from 'ethers';
import {parseEther} from 'ethers/lib/utils';
import {addDays, getUnixTime} from 'date-fns';
const BN = ethers.BigNumber;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getMock(name: string, deployer: string, args: Array<any>): Promise<Contract> {
  await deployments.deploy(name, {from: deployer, args: args});
  return ethers.getContract(name, deployer);
}

const timeTravelTo = async (time: number) => {
  await network.provider.send('evm_setNextBlockTimestamp', [time]);
  await network.provider.send('evm_mine');
};
interface setUser {
  address: string;
  TokenLock: TokenLock;
  TDFToken: TDFToken;
  ProofOfPresence: ProofOfPresence;
}
const setupHelpers = async ({
  stakeContract,
  tokenContract,
  bookingContract,
  user,
  admin,
}: {
  stakeContract: TokenLock;
  tokenContract: TDFToken;
  bookingContract: ProofOfPresence;
  user: setUser;
  admin?: setUser;
}) => {
  return {
    testBalances: async (TK: string, tkU: string, u: string) => {
      expect(await tokenContract.balanceOf(stakeContract.address)).to.eq(parseEther(TK));
      expect(await stakeContract.balanceOf(user.address)).to.eq(parseEther(tkU));
      expect(await tokenContract.balanceOf(user.address)).to.eq(parseEther(u));
    },
    testStake: async (locked: string, unlocked: string) => {
      expect(await stakeContract.lockedAmount(user.address)).to.eq(parseEther(locked));
      expect(await stakeContract.unlockedAmount(user.address)).to.eq(parseEther(unlocked));
    },
    testDeposits: async (examples: [string, number][]) => {
      const deposits = await stakeContract.depositsFor(user.address);
      for (let i = 0; i < deposits.length; i++) {
        expect(deposits[i].amount).to.eq(parseEther(examples[i][0]));
        expect(deposits[i].timestamp).to.eq(BN.from(examples[i][1]));
      }
    },
    testBookings: async (dates: number[], price: string) => {
      await Promise.all(
        dates.map(async (e) => {
          const [d, c] = await bookingContract.getBooking(user.address, e);
          return Promise.all([expect(d).to.eq(e), expect(c).to.eq(parseEther(price))]);
        })
      );
    },
  };
};

const setup = deployments.createFixture(async (hre) => {
  const {deployments, getNamedAccounts, ethers} = hre;
  await deployments.fixture();

  const accounts = await getNamedAccounts();
  const users = await getUnnamedAccounts();
  const {deployer, TDFTokenBeneficiary} = accounts;

  const token = <TDFToken>await ethers.getContract('TDFToken', deployer);
  const stakeContract = <TokenLock>await getMock('TokenLock', deployer, [token.address, 1]);
  const pOP = <ProofOfPresence>await getMock('ProofOfPresence', deployer, [token.address, stakeContract.address]);
  const contracts = {
    TDFToken: token,
    ProofOfPresence: pOP,
    TokenLock: stakeContract,
  };

  const tokenBeneficiary = await setupUser(TDFTokenBeneficiary, contracts);

  const conf = {
    ...contracts,
    users: await setupUsers(users, contracts),
    deployer: await setupUser(deployer, contracts),
    TDFTokenBeneficiary: tokenBeneficiary,
    accounts,
  };

  await Promise.all(
    [users[0], users[1]].map((e) => {
      return conf.TDFTokenBeneficiary.TDFToken.transfer(e, parseEther('10000'));
    })
  );
  return conf;
});

const buildDates = (initDate: Date, amount: number) => {
  const acc = [];
  for (let i = 0; i < amount; i++) {
    acc.push(getUnixTime(addDays(initDate, i)));
  }
  return acc;
};

describe('ProofOfPresence', () => {
  it('book', async () => {
    const {users, ProofOfPresence, TDFToken, TokenLock} = await setup();

    const user = users[0];
    const {testBalances} = await setupHelpers({
      stakeContract: TokenLock,
      tokenContract: TDFToken,
      bookingContract: ProofOfPresence,
      user: user,
    });

    await user.TDFToken.approve(TokenLock.address, parseEther('10'));
    const init = addDays(Date.now(), 10);
    const dates = buildDates(init, 5);
    await user.ProofOfPresence.book(dates);
    await testBalances('5', '5', '9995');
  });
  it('book and cancel', async () => {
    const {users, ProofOfPresence, TDFToken, TokenLock} = await setup();
    const user = users[0];

    const {testBalances, testBookings} = await setupHelpers({
      stakeContract: TokenLock,
      tokenContract: TDFToken,
      bookingContract: ProofOfPresence,
      user: user,
    });

    await user.TDFToken.approve(TokenLock.address, parseEther('10'));
    const init = addDays(Date.now(), 10);
    const dates = buildDates(init, 5);

    // -------------------------------------------------------
    //  Book and cancel all the dates
    // -------------------------------------------------------
    await user.ProofOfPresence.book(dates);
    await testBalances('5', '5', '9995');
    await testBookings(dates, '1');

    await user.ProofOfPresence.cancel(dates);
    expect((await ProofOfPresence.getDates(user.address)).length).to.eq(0);
    await testBalances('5', '5', '9995');
    await testBookings(dates, '0');
    // -------------------------------------------------------
    //  Book and cancel few dates
    // -------------------------------------------------------
    await user.ProofOfPresence.book(dates);
    await testBalances('5', '5', '9995');
    await testBookings(dates, '1');

    const cDates = [dates[0], dates[4]];
    await user.ProofOfPresence.cancel(cDates);
    expect((await ProofOfPresence.getDates(user.address)).length).to.eq(3);
    await testBalances('5', '5', '9995');
    await testBookings(cDates, '0');
    await testBookings([dates[1], dates[2], dates[3]], '1');
    await expect(user.ProofOfPresence.cancel(cDates)).to.be.revertedWith('Booking does not exists');

    await timeTravelTo(dates[4] + 2 * 86400);
    await expect(user.ProofOfPresence.cancel([dates[1], dates[2], dates[3]])).to.be.revertedWith(
      'Can not cancel past booking'
    );
  });

  it('getters', async () => {});

  it('ownable', async () => {});

  it('pausable', async () => {});
});