// SPDX-License-Identifier: MIT

pragma solidity 0.8.9;

import "@openzeppelin/contracts/utils/structs/DoubleEndedQueue.sol";

library OrderedStakeLib {
    using DoubleEndedQueue for DoubleEndedQueue.Bytes32Deque;

    // ONLY MEMORY!!
    struct Deposit {
        uint256 timestamp;
        uint256 amount;
    }

    // TODO rename to Account
    struct Store {
        uint256 _balance;
        DoubleEndedQueue.Bytes32Deque _queue;
        mapping(bytes32 => uint256) _amounts;
    }

    function push(
        Store storage store,
        uint256 amount,
        uint256 timestamp
    ) internal {
        _pushBackOrdered(store, amount, timestamp);
    }

    function length(Store storage store) internal view returns (uint256) {
        return store._queue.length();
    }

    function at(Store storage store, uint256 index) internal view returns (Deposit memory deposit) {
        bytes32 key = store._queue.at(index);
        deposit.timestamp = uint256(key);
        deposit.amount = uint256(store._amounts[key]);
    }

    function list(Store storage store) internal view returns (OrderedStakeLib.Deposit[] memory) {
        Deposit[] memory deposits_ = new Deposit[](length(store));
        for (uint256 i; i < length(store); i++) {
            deposits_[i] = at(store, i);
        }
        return deposits_;
    }

    function empty(Store storage store) internal view returns (bool) {
        return store._queue.empty();
    }

    function tryTakeUntil(
        Store storage store,
        uint256 requested,
        uint256 untilTm
    ) internal returns (bool) {
        if (requested >= balanceUntil(store, untilTm)) return false;
        takeUntil(store, requested, untilTm);
        return true;
    }

    function takeUntil(
        Store storage store,
        uint256 requested,
        uint256 untilTm
    ) internal {
        require(requested > uint256(0), "Nothing Requested");
        require(store._balance >= requested, "NOT_ENOUGH_BALANCE");

        uint256 current_extracted;

        while (current_extracted < requested) {
            OrderedStakeLib.Deposit memory current_deposit = _popFront(store);
            if (current_deposit.timestamp <= untilTm) {
                if (current_deposit.amount + current_extracted == requested) {
                    current_extracted += current_deposit.amount;
                } else if (current_deposit.amount + current_extracted > requested) {
                    // substract front
                    uint256 reminder = current_deposit.amount + current_extracted - requested;
                    _pushFront(store, reminder, current_deposit.timestamp);
                    current_extracted = requested;
                } else {
                    current_extracted += current_deposit.amount;
                }
            } else {
                revert("NOT_ENOUGHT_UNLOCKABLE_BALANCE");
            }
        }
    }

    function takeMaxUntil(Store storage store, uint256 untilTm) internal returns (uint256 amount) {
        amount = balanceUntil(store, untilTm);
        if (amount == uint256(0)) return amount;
        takeUntil(store, amount, untilTm);
    }

    // @dev
    // Including current timestamp
    function balanceUntil(Store storage store, uint256 untilTm) internal view returns (uint256 amount) {
        if (store._queue.empty()) return 0;
        for (uint256 i; i < store._queue.length(); i++) {
            uint256 tm = uint256(store._queue.at(i));
            if (tm <= untilTm) {
                amount += store._amounts[store._queue.at(i)];
                if (tm == untilTm) break;
            } else {
                break;
            }
        }
    }

    // @dev
    // NonIncluded
    // not including current TM since balanceUntil includes the current timestamp
    function balanceFrom(Store storage store, uint256 fromTm) internal view returns (uint256) {
        return store._balance - balanceUntil(store, fromTm);
    }

    // ===================================
    // PRIVATE FUNCTIONS
    // ===================================

    function _pushBackOrdered(
        Store storage store,
        uint256 amount,
        uint256 timestamp
    ) internal {
        if (store._queue.empty()) {
            _pushBack(store, amount, timestamp);
        } else {
            uint256 backTm = uint256(store._queue.back());
            if (backTm < timestamp) {
                _pushBack(store, amount, timestamp);
            } else if (backTm == timestamp) {
                _addAmountToBack(store, amount, timestamp);
            } else {
                bytes32 last = store._queue.popBack();
                push(store, amount, timestamp);
                store._queue.pushBack(last);
            }
        }
    }

    function _popFront(Store storage store) internal returns (Deposit memory deposit) {
        bytes32 key = store._queue.popFront();
        uint256 val = store._amounts[key];
        delete store._amounts[key];
        store._balance -= val;
        deposit.timestamp = uint256(key);
        deposit.amount = val;
    }

    function _pushFront(
        Store storage store,
        uint256 amount,
        uint256 timestamp
    ) internal {
        bytes32 key = bytes32(timestamp);
        store._queue.pushFront(key);
        store._amounts[key] = amount;
        store._balance += amount;
    }

    // PRIVATE do not use use _pushBackOrdered instead
    function _pushBack(
        Store storage store,
        uint256 amount,
        uint256 timestamp
    ) internal {
        bytes32 key = bytes32(timestamp);
        require(store._amounts[key] == uint256(0), "CAN NOT OVERRIDE TIMESTAMPS");
        store._queue.pushBack(key);
        store._amounts[key] = amount;
        store._balance += amount;
    }

    function _addAmountToBack(
        Store storage store,
        uint256 amount,
        uint256 timestamp
    ) internal {
        bytes32 key = bytes32(timestamp);
        require(store._amounts[key] != uint256(0), "Trying to update empty");
        store._amounts[key] += amount;
        store._balance += amount;
    }
}
